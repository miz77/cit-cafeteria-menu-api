import { createHash } from "node:crypto";
import type { LocationStatus } from "@cit-cafeteria/schema";
import { fetchFailureSlug, formatFetchErrorDetails, INGEST_USER_AGENT, logFetchFailure } from "./fetchDiagnostics";
import { loadPdfOperatorPage, resolvePdfOperatorRuntime, type PdfOperatorPageProxy } from "./pdfOperatorSource";
import { extractPdfRulings, type PdfPageGeometry } from "./pdfRulings";
import type { IngestSource } from "./sources";

export interface PdfLimits {
  maxSourcePdfBytes: number;
  hardMaxSourcePdfBytes: number;
  expectedPagesPerPdf: number;
  maxPagesPerPdf: number;
  maxTextItemsPerPdf: number;
  maxRawTextCharsPerLocationPerDate: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxSourcePdfBytes: 5 * 1024 * 1024,
  hardMaxSourcePdfBytes: 10 * 1024 * 1024,
  expectedPagesPerPdf: 1,
  maxPagesPerPdf: 3,
  maxTextItemsPerPdf: 30_000,
  maxRawTextCharsPerLocationPerDate: 20_000
};

export interface FetchedPdf {
  source: IngestSource;
  bytes: Uint8Array;
  fetchedAt: string;
  sha256: string;
  warnings: string[];
}

export interface PdfTextItem {
  text: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfExtraction {
  pageCount: number;
  items: PdfTextItem[];
  warnings: string[];
  pageGeometry?: PdfPageGeometry[];
}

interface PdfPageProxy extends PdfOperatorPageProxy {
  getTextContent: () => Promise<{ items: Array<Record<string, unknown>> }>;
}

export class PdfFetchError extends Error {
  constructor(
    message: string,
    readonly status: LocationStatus,
    readonly warnings: string[] = []
  ) {
    super(message);
  }
}

export async function fetchPdf(
  source: IngestSource,
  limits: PdfLimits,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedPdf> {
  let response: Response;
  try {
    response = await fetchImpl(source.pdfUrl, {
      headers: {
        "user-agent": INGEST_USER_AGENT
      }
    });
  } catch (error) {
    throw fetchNetworkError(source.pdfUrl, "request", error);
  }

  if (!response.ok) {
    throw new PdfFetchError(`Failed to fetch ${source.pdfUrl}: ${response.status}`, "fetch_failed");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > limits.hardMaxSourcePdfBytes) {
    throw new PdfFetchError(`Source PDF is too large: ${contentLength} bytes`, "source_too_large", [
      "source_pdf_hard_size_limit_exceeded"
    ]);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw fetchNetworkError(source.pdfUrl, "body", error);
  }
  if (bytes.byteLength > limits.hardMaxSourcePdfBytes) {
    throw new PdfFetchError(`Source PDF is too large: ${bytes.byteLength} bytes`, "source_too_large", [
      "source_pdf_hard_size_limit_exceeded"
    ]);
  }

  const warnings = [...source.warnings];
  if (bytes.byteLength > limits.maxSourcePdfBytes) {
    warnings.push("source_pdf_soft_size_limit_exceeded");
  }

  return {
    source,
    bytes,
    fetchedAt: new Date().toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    warnings
  };
}

function fetchNetworkError(url: string, stage: "request" | "body", error: unknown): PdfFetchError {
  const details = logFetchFailure("pdf", url, error, stage);
  return new PdfFetchError(`Failed to fetch ${url}: ${formatFetchErrorDetails(details)}`, "fetch_failed", [
    `pdf_fetch_network_${fetchFailureSlug(details)}`
  ]);
}

export async function extractTextItemsFromPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  const unpdf = (await import("unpdf")) as Record<string, unknown>;
  const getDocumentProxy = unpdf.getDocumentProxy as undefined | ((source: unknown) => Promise<unknown>);
  const getResolvedPDFJS = unpdf.getResolvedPDFJS as undefined | (() => Promise<unknown>);

  if (getDocumentProxy) {
    const operatorRuntime = await resolvePdfOperatorRuntime(getResolvedPDFJS);
    return extractWithDocumentProxy(getDocumentProxy, bytes, operatorRuntime);
  }

  const extractText = unpdf.extractText as undefined | ((source: unknown, options?: unknown) => Promise<unknown>);
  if (extractText) {
    return extractWithPlainText(extractText, bytes);
  }

  throw new Error("unpdf did not expose getDocumentProxy or extractText");
}

async function extractWithDocumentProxy(
  getDocumentProxy: (source: unknown) => Promise<unknown>,
  bytes: Uint8Array,
  operatorRuntime: Awaited<ReturnType<typeof resolvePdfOperatorRuntime>>
): Promise<PdfExtraction> {
  const pdf = (await getDocumentProxy(bytes)) as {
    numPages?: number;
    getPage?: (pageNumber: number) => Promise<PdfPageProxy>;
  };

  const pageCount = Number(pdf.numPages ?? 0);
  if (!pageCount || !pdf.getPage) throw new Error("Could not read PDF page count");

  const items: PdfTextItem[] = [];
  const warnings = [...operatorRuntime.warnings];
  const pageGeometry: PdfPageGeometry[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    // Keep text extraction first: PDF.js initializes shared font identifiers
    // while producing text content.
    const textContent = await page.getTextContent();
    for (const rawItem of textContent.items) {
      const text = String(rawItem.str ?? "").trim();
      if (!text) continue;

      const transform = Array.isArray(rawItem.transform) ? rawItem.transform : [];
      items.push({
        text,
        page: pageNumber,
        x: Number(transform[4] ?? 0),
        y: Number(transform[5] ?? 0),
        width: Number(rawItem.width ?? 0),
        height: Number(rawItem.height ?? 0)
      });
    }

    if (operatorRuntime.value) {
      const operatorPage = await loadPdfOperatorPage(page, pageNumber, operatorRuntime.value);
      pushUnique(warnings, operatorPage.warnings);
      if (operatorPage.value) {
        const rulingResult = extractPdfRulings(operatorPage.value);
        pageGeometry.push(rulingResult.geometry);
        pushUnique(warnings, rulingResult.warnings);
      }
    }
  }

  return { pageCount, items, warnings, pageGeometry };
}

async function extractWithPlainText(
  extractText: (source: unknown, options?: unknown) => Promise<unknown>,
  bytes: Uint8Array
): Promise<PdfExtraction> {
  const result = await extractText(bytes, { mergePages: false });
  const text = resultToText(result);
  const pageCount = resultToPageCount(result) ?? 1;
  const items = text
    .split(/\r?\n/)
    .map((line, index) => ({
      text: line.trim(),
      page: 1,
      x: 0,
      y: 10_000 - index * 10,
      width: 0,
      height: 0
    }))
    .filter((item) => item.text);

  return {
    pageCount,
    items,
    warnings: ["pdf_text_extracted_without_coordinates"]
  };
}

function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.pages)) {
    return record.pages
      .map((page) => {
        if (typeof page === "string") return page;
        if (page && typeof page === "object" && typeof (page as Record<string, unknown>).text === "string") {
          return (page as Record<string, string>).text;
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function resultToPageCount(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (typeof record.totalPages === "number") return record.totalPages;
  if (typeof record.pageCount === "number") return record.pageCount;
  if (Array.isArray(record.pages)) return record.pages.length;
  return null;
}

function pushUnique(target: string[], additions: readonly string[]): void {
  for (const addition of additions) {
    if (!target.includes(addition)) target.push(addition);
  }
}

export const __test__ = { extractWithDocumentProxy };
