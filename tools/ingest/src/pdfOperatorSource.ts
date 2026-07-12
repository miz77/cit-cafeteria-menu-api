export const MAX_PDF_OPERATORS_PER_PAGE = 100_000;

import type { PdfBounds } from "./pdfGraphicsState";

export interface PdfOperatorRuntime {
  ops: Readonly<Record<string, number>>;
  version: string | null;
}

export interface PdfOperatorPage {
  pageNumber: number;
  view: PdfBounds;
  fnArray: readonly number[];
  argsArray: readonly unknown[];
  runtime: PdfOperatorRuntime;
}

export interface PdfOperatorResult<T> {
  value: T | null;
  warnings: string[];
}

export interface PdfOperatorPageProxy {
  view?: unknown;
  getOperatorList?: () => Promise<{ fnArray?: unknown; argsArray?: unknown }>;
}

export async function resolvePdfOperatorRuntime(
  getResolvedPDFJS: undefined | (() => Promise<unknown>)
): Promise<PdfOperatorResult<PdfOperatorRuntime>> {
  if (!getResolvedPDFJS) return unavailable("pdf_operator_runtime_unavailable");

  try {
    const pdfJs = await getResolvedPDFJS();
    if (!pdfJs || typeof pdfJs !== "object") return unavailable("pdf_operator_runtime_invalid");
    const record = pdfJs as Record<string, unknown>;
    if (!record.OPS || typeof record.OPS !== "object") return unavailable("pdf_operator_runtime_invalid");

    const ops = Object.fromEntries(
      Object.entries(record.OPS as Record<string, unknown>)
        .map(([name, value]) => [name, Number(value)] as const)
        .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1]))
    );
    if (Object.keys(ops).length === 0) return unavailable("pdf_operator_runtime_invalid");

    return {
      value: {
        ops,
        version: typeof record.version === "string" ? record.version : null
      },
      warnings: []
    };
  } catch {
    return unavailable("pdf_operator_runtime_unavailable");
  }
}

export async function loadPdfOperatorPage(
  page: PdfOperatorPageProxy,
  pageNumber: number,
  runtime: PdfOperatorRuntime,
  maxOperators = MAX_PDF_OPERATORS_PER_PAGE
): Promise<PdfOperatorResult<PdfOperatorPage>> {
  if (!page.getOperatorList) return unavailable("pdf_operator_list_unavailable");

  try {
    const operatorList = await page.getOperatorList();
    const fnArray = numberArray(operatorList.fnArray);
    const argsArray = Array.isArray(operatorList.argsArray) ? operatorList.argsArray : null;
    const view = boundsFromView(page.view);
    if (!fnArray || !argsArray || !view || fnArray.length !== argsArray.length || !fnArray.every(Number.isInteger)) {
      return unavailable("pdf_operator_list_invalid");
    }
    if (fnArray.length > maxOperators) return unavailable("pdf_operator_limit_exceeded");

    return {
      value: { pageNumber, view, fnArray, argsArray, runtime },
      warnings: []
    };
  } catch {
    return unavailable("pdf_operator_list_unavailable");
  }
}

function boundsFromView(value: unknown): PdfBounds | null {
  const numbers = numberArray(value);
  if (!numbers || numbers.length < 4) return null;
  const left = Math.min(numbers[0], numbers[2]);
  const right = Math.max(numbers[0], numbers[2]);
  const bottom = Math.min(numbers[1], numbers[3]);
  const top = Math.max(numbers[1], numbers[3]);
  return right > left && top > bottom ? { left, bottom, right, top } : null;
}

function numberArray(value: unknown): number[] | null {
  const values = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<unknown>)
      : null;
  if (!values) return null;
  const numbers = values.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

function unavailable<T>(warning: string): PdfOperatorResult<T> {
  return { value: null, warnings: [warning] };
}
