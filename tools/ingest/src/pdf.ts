import { createHash } from "node:crypto";
import type { LocationStatus } from "@cit-cafeteria/schema";
import { fetchFailureSlug, formatFetchErrorDetails, INGEST_USER_AGENT, logFetchFailure } from "./fetchDiagnostics";
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
}

interface RawPdfTextItem extends PdfTextItem {
  fontName: string;
}

interface PdfJsOperatorCodes {
  save: number;
  restore: number;
  transform: number;
  setFont: number;
  setHScale: number;
  setTextMatrix: number;
  showText: number;
}

interface OperatorGlyph {
  text: string;
  startUnits: number;
  endUnits: number;
}

interface OperatorTextRun {
  text: string;
  fontName: string;
  x: number;
  y: number;
  unitScale: number;
  totalUnits: number;
  glyphs: OperatorGlyph[];
}

interface TextRecoveryResult {
  items: RawPdfTextItem[];
  recoveredCount: number;
  ambiguousCount: number;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
// Excel-generated PDFs can clip the first or last glyph from getTextContent
// while retaining the complete Unicode run in the page operator list. Keep
// recovery deliberately small so hidden overflow text is never imported.
const MAX_RECOVERED_AFFIX_GLYPHS = 2;
const MAX_RECOVERED_AFFIX_RATIO = 0.25;

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
    const operatorCodes = getResolvedPDFJS ? operatorCodesFromPdfJs(await getResolvedPDFJS()) : null;
    return extractWithDocumentProxy(getDocumentProxy, bytes, operatorCodes);
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
  operatorCodes: PdfJsOperatorCodes | null
): Promise<PdfExtraction> {
  const pdf = (await getDocumentProxy(bytes)) as {
    numPages?: number;
    getPage?: (pageNumber: number) => Promise<{
      getTextContent: () => Promise<{ items: Array<Record<string, unknown>> }>;
      getOperatorList?: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
    }>;
  };

  const pageCount = Number(pdf.numPages ?? 0);
  if (!pageCount || !pdf.getPage) throw new Error("Could not read PDF page count");

  const items: PdfTextItem[] = [];
  const warnings: string[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageItems: RawPdfTextItem[] = [];
    for (const rawItem of textContent.items) {
      const text = String(rawItem.str ?? "").trim();
      if (!text) continue;

      const transform = Array.isArray(rawItem.transform) ? rawItem.transform : [];
      pageItems.push({
        text,
        page: pageNumber,
        x: Number(transform[4] ?? 0),
        y: Number(transform[5] ?? 0),
        width: Number(rawItem.width ?? 0),
        height: Number(rawItem.height ?? 0),
        fontName: String(rawItem.fontName ?? "")
      });
    }

    let recovered = { items: pageItems, recoveredCount: 0, ambiguousCount: 0 } satisfies TextRecoveryResult;
    if (operatorCodes && page.getOperatorList) {
      const operatorList = await page.getOperatorList();
      const runs = collectOperatorTextRuns(operatorList, operatorCodes);
      recovered = recoverClippedTextAffixes(pageItems, runs);
    }

    if (recovered.recoveredCount > 0 && !warnings.includes("pdf_text_affix_recovered_from_operator_list")) {
      warnings.push("pdf_text_affix_recovered_from_operator_list");
    }
    if (recovered.ambiguousCount > 0 && !warnings.includes("pdf_text_affix_recovery_ambiguous")) {
      warnings.push("pdf_text_affix_recovery_ambiguous");
    }
    items.push(...recovered.items.map(({ fontName: _fontName, ...item }) => item));
  }

  return { pageCount, items, warnings };
}

function operatorCodesFromPdfJs(value: unknown): PdfJsOperatorCodes | null {
  if (!value || typeof value !== "object") return null;
  const ops = (value as Record<string, unknown>).OPS;
  if (!ops || typeof ops !== "object") return null;
  const record = ops as Record<string, unknown>;
  const codes = {
    save: Number(record.save),
    restore: Number(record.restore),
    transform: Number(record.transform),
    setFont: Number(record.setFont),
    setHScale: Number(record.setHScale),
    setTextMatrix: Number(record.setTextMatrix),
    showText: Number(record.showText)
  };
  return Object.values(codes).every(Number.isFinite) ? codes : null;
}

function collectOperatorTextRuns(
  operatorList: { fnArray: number[]; argsArray: unknown[] },
  codes: PdfJsOperatorCodes
): OperatorTextRun[] {
  const runs: OperatorTextRun[] = [];
  const matrixStack: Matrix[] = [];
  let currentMatrix: Matrix = [...IDENTITY_MATRIX];
  let textMatrix: Matrix = [...IDENTITY_MATRIX];
  let fontName = "";
  let fontSize = 0;
  let horizontalScale = 1;

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === codes.save) {
      matrixStack.push([...currentMatrix]);
      continue;
    }
    if (fn === codes.restore) {
      currentMatrix = matrixStack.pop() ?? [...IDENTITY_MATRIX];
      continue;
    }
    if (fn === codes.transform) {
      const matrix = numberTuple(args);
      if (matrix) currentMatrix = multiplyMatrices(currentMatrix, matrix);
      continue;
    }
    if (fn === codes.setFont && Array.isArray(args)) {
      fontName = String(args[0] ?? "");
      fontSize = Number(args[1] ?? 0);
      continue;
    }
    if (fn === codes.setHScale) {
      const scale = Number(Array.isArray(args) ? args[0] : args);
      if (Number.isFinite(scale)) horizontalScale = Math.abs(scale) > 10 ? scale / 100 : scale;
      continue;
    }
    if (fn === codes.setTextMatrix) {
      const matrix = numberTuple(args);
      if (matrix) textMatrix = matrix;
      continue;
    }
    if (fn !== codes.showText || !Array.isArray(args)) continue;

    const parsed = parseOperatorGlyphs(args[0]);
    if (!parsed || !fontName || !fontSize) continue;
    const combined = multiplyMatrices(currentMatrix, textMatrix);
    const xScale = Math.hypot(combined[0], combined[1]);
    const unitScale = (Math.abs(fontSize * horizontalScale) * xScale) / 1000;
    if (!Number.isFinite(unitScale) || unitScale <= 0) continue;

    runs.push({
      text: parsed.text,
      fontName,
      x: combined[4],
      y: combined[5],
      unitScale,
      totalUnits: parsed.totalUnits,
      glyphs: parsed.glyphs
    });
  }

  return runs;
}

function parseOperatorGlyphs(value: unknown): { text: string; totalUnits: number; glyphs: OperatorGlyph[] } | null {
  if (!Array.isArray(value)) return null;
  const glyphs: OperatorGlyph[] = [];
  let units = 0;

  for (const entry of value) {
    if (typeof entry === "number") {
      units -= entry;
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const text = String(record.unicode ?? "");
    const width = Number(record.width ?? 0);
    if (!Number.isFinite(width)) continue;
    const startUnits = units;
    units += width;
    if (text) glyphs.push({ text, startUnits, endUnits: units });
  }

  const text = glyphs
    .map((glyph) => glyph.text)
    .join("")
    .trim();
  return text && glyphs.length > 0 ? { text, totalUnits: units, glyphs } : null;
}

function recoverClippedTextAffixes(
  items: readonly RawPdfTextItem[],
  runs: readonly OperatorTextRun[]
): TextRecoveryResult {
  let recoveredCount = 0;
  let ambiguousCount = 0;
  const recoveredItems = items.map((item) => {
    const recoveredTexts = new Set<string>();
    for (const run of runs) {
      if (run.fontName !== item.fontName) continue;
      if (!sameBaseline(item, run)) continue;
      if (isSafeAffixRecovery(item, run)) recoveredTexts.add(run.text);
    }

    if (recoveredTexts.size === 1) {
      recoveredCount += 1;
      return { ...item, text: [...recoveredTexts][0] };
    }
    if (recoveredTexts.size > 1) ambiguousCount += 1;
    return { ...item };
  });

  return { items: recoveredItems, recoveredCount, ambiguousCount };
}

function sameBaseline(item: RawPdfTextItem, run: OperatorTextRun): boolean {
  const tolerance = Math.max(1, item.height * 0.15);
  return Math.abs(item.y - run.y) <= tolerance;
}

function isSafeAffixRecovery(item: RawPdfTextItem, run: OperatorTextRun): boolean {
  if (run.text === item.text || run.glyphs.length <= 1) return false;
  const maxMissing = Math.min(MAX_RECOVERED_AFFIX_GLYPHS, Math.floor(run.glyphs.length * MAX_RECOVERED_AFFIX_RATIO));
  if (maxMissing < 1) return false;

  for (let missingGlyphs = 1; missingGlyphs <= maxMissing; missingGlyphs += 1) {
    // Only strict glyph-boundary prefix/suffix extensions are eligible. This
    // intentionally rejects substitutions and internal edits.
    const prefixKept = run.glyphs
      .slice(missingGlyphs)
      .map((glyph) => glyph.text)
      .join("");
    if (prefixKept === item.text) {
      const keptStartUnits = run.glyphs[missingGlyphs].startUnits;
      if (matchesRecoveredGeometry(item, run, keptStartUnits, run.totalUnits - keptStartUnits)) return true;
    }

    const keptGlyphs = run.glyphs.slice(0, -missingGlyphs);
    const suffixKept = keptGlyphs.map((glyph) => glyph.text).join("");
    if (suffixKept === item.text) {
      const keptUnits = keptGlyphs.at(-1)?.endUnits ?? 0;
      if (matchesRecoveredGeometry(item, run, 0, keptUnits)) return true;
    }
  }

  return false;
}

function matchesRecoveredGeometry(
  item: RawPdfTextItem,
  run: OperatorTextRun,
  keptStartUnits: number,
  keptWidthUnits: number
): boolean {
  const expectedX = run.x + keptStartUnits * run.unitScale;
  const expectedWidth = keptWidthUnits * run.unitScale;
  const positionTolerance = Math.max(1, item.height * 0.15);
  const widthTolerance = Math.max(1, item.height * 0.2);
  return Math.abs(item.x - expectedX) <= positionTolerance && Math.abs(item.width - expectedWidth) <= widthTolerance;
}

function numberTuple(value: unknown): Matrix | null {
  const candidate = Array.isArray(value) && value.length === 1 && typeof value[0] === "object" ? value[0] : value;
  const numbers = Array.isArray(candidate)
    ? candidate.map(Number)
    : ArrayBuffer.isView(candidate)
      ? Array.from(candidate as unknown as ArrayLike<number>, Number)
      : candidate && typeof candidate === "object"
        ? Array.from({ length: 6 }, (_, index) => Number((candidate as Record<number, unknown>)[index]))
        : [];
  if (numbers.length < 6 || !numbers.slice(0, 6).every(Number.isFinite)) return null;
  return [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]];
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
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

export const __test__ = {
  collectOperatorTextRuns,
  recoverClippedTextAffixes
};
