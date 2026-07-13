import type { PdfBounds } from "./pdfGraphicsState";
import type { PdfOperatorTextRun } from "./pdfTextOperators";

export interface PdfEdgeOverflowMenuEvidence {
  page: number;
  name: string;
  priceYen: number;
  side: "left" | "right";
  bounds: PdfBounds;
  baselineY: number;
  sourceRunIndexes: number[];
}

export interface PdfEdgeOverflowDiagnostic {
  code: "pdf_text_edge_overflow_recovered";
  page: number;
  name: string;
  priceYen: number;
  side: "left" | "right";
  bounds: PdfBounds;
  sourceRunIndexes: number[];
}

export interface PdfEdgeOverflowResult {
  evidence: PdfEdgeOverflowMenuEvidence[];
  diagnostics: PdfEdgeOverflowDiagnostic[];
  warnings: string[];
}

interface IndexedRun {
  index: number;
  run: PdfOperatorTextRun;
}

interface ParsedStart {
  name: string;
  leadingDigits: string;
}

interface TypographyAnchor {
  nameFonts: Set<string>;
  digitFonts: Set<string>;
}

const MAX_PRICE_DIGITS = 5;

/**
 * Collects complete name/price cells that PDF.js omitted solely because their
 * operator text is wholly outside the horizontal page view. The result remains
 * evidence until the parser assigns it to one unambiguous shared row.
 */
export function collectPdfEdgeOverflowMenuEvidence(
  runs: readonly PdfOperatorTextRun[],
  pageView: PdfBounds,
  excludedRunIndexes: ReadonlySet<number> = new Set()
): PdfEdgeOverflowResult {
  const indexed = runs.map((run, index) => ({ run, index }));
  const outside = indexed.filter(
    ({ index, run }) => !excludedRunIndexes.has(index) && horizontalSide(run.bounds, pageView) !== null
  );
  const visible = indexed.filter(({ run }) => intersectsView(run.bounds, pageView));
  const anchors = indexVisibleTypography(visible);
  const evidence: PdfEdgeOverflowMenuEvidence[] = [];
  let incomplete = false;

  for (const line of groupOutsideLines(outside, pageView)) {
    for (let position = 0; position < line.length; position += 1) {
      const entry = line[position];
      const start = parseNamePriceStart(entry.run.text);
      if (!start) continue;
      const side = horizontalSide(entry.run.bounds, pageView);
      if (!side) continue;

      const sourceRuns = [entry];
      let digits = start.leadingDigits;
      let right = entry.run.bounds.right;
      for (let next = position + 1; next < line.length; next += 1) {
        const candidate = line[next];
        if (!isDigitText(candidate.run.text) || !isAdjacent(right, candidate.run.bounds.left, entry.run.bounds)) break;
        sourceRuns.push(candidate);
        digits += normalizePdfText(candidate.run.text).replace(/\D/g, "");
        right = candidate.run.bounds.right;
        if (digits.length >= MAX_PRICE_DIGITS) break;
      }

      if (!/^\d{2,5}$/.test(digits)) {
        incomplete = true;
        continue;
      }
      if (
        !hasVisibleTypographyAnchor(
          entry.run,
          sourceRuns.slice(1).map(({ run }) => run),
          anchors
        )
      )
        continue;

      const bounds = unionBounds(sourceRuns.map(({ run }) => run.bounds));
      evidence.push({
        page: entry.run.page,
        name: start.name,
        priceYen: Number(digits),
        side,
        bounds,
        baselineY: entry.run.baselineY,
        sourceRunIndexes: sourceRuns.map(({ index }) => index)
      });
    }
  }

  const { unique, duplicate } = uniqueEvidence(evidence);
  const ambiguous = duplicate;
  return {
    evidence: ambiguous ? [] : unique,
    diagnostics: ambiguous
      ? []
      : unique.map((item) => ({
          code: "pdf_text_edge_overflow_recovered",
          page: item.page,
          name: item.name,
          priceYen: item.priceYen,
          side: item.side,
          bounds: item.bounds,
          sourceRunIndexes: item.sourceRunIndexes
        })),
    warnings: [
      ...(ambiguous ? ["pdf_text_edge_overflow_ambiguous"] : []),
      ...(incomplete ? ["pdf_text_edge_overflow_incomplete_pair"] : [])
    ]
  };
}

function parseNamePriceStart(text: string): ParsedStart | null {
  const match = normalizePdfText(text).match(/^(.+?)[¥\\]\s*(\d*)$/);
  if (!match) return null;
  const name = match[1].trim();
  return name ? { name, leadingDigits: match[2] } : null;
}

function hasVisibleTypographyAnchor(
  nameRun: PdfOperatorTextRun,
  priceRuns: readonly PdfOperatorTextRun[],
  anchors: ReadonlyMap<string, TypographyAnchor>
): boolean {
  const nearby = nearbyTypographyAnchors(nameRun, anchors);
  if (!nearby.some((anchor) => anchor.nameFonts.has(nameRun.fontName))) return false;
  if (priceRuns.length === 0) return /\d/.test(normalizePdfText(nameRun.text));
  return priceRuns.every((priceRun) => nearby.some((anchor) => anchor.digitFonts.has(priceRun.fontName)));
}

function indexVisibleTypography(visible: readonly IndexedRun[]): Map<string, TypographyAnchor> {
  const anchors = new Map<string, TypographyAnchor>();
  for (const { run } of visible) {
    const key = typographyKey(run.page, Math.round(run.baselineY));
    const anchor = anchors.get(key) ?? { nameFonts: new Set<string>(), digitFonts: new Set<string>() };
    if (/^.+?[¥\\]/.test(normalizePdfText(run.text))) anchor.nameFonts.add(run.fontName);
    if (isDigitText(run.text)) anchor.digitFonts.add(run.fontName);
    anchors.set(key, anchor);
  }
  return anchors;
}

function nearbyTypographyAnchors(
  run: PdfOperatorTextRun,
  anchors: ReadonlyMap<string, TypographyAnchor>
): TypographyAnchor[] {
  const baseline = Math.round(run.baselineY);
  return [-1, 0, 1]
    .map((offset) => anchors.get(typographyKey(run.page, baseline + offset)))
    .filter((anchor): anchor is TypographyAnchor => anchor !== undefined);
}

function typographyKey(page: number, baseline: number): string {
  return `${page}:${baseline}`;
}

function groupOutsideLines(outside: readonly IndexedRun[], view: PdfBounds): IndexedRun[][] {
  const groups = new Map<string, IndexedRun[]>();
  for (const entry of outside) {
    const side = horizontalSide(entry.run.bounds, view);
    const key = `${entry.run.page}:${side}:${Math.round(entry.run.baselineY)}`;
    const line = groups.get(key) ?? [];
    line.push(entry);
    groups.set(key, line);
  }
  return Array.from(groups.values()).map((line) =>
    line.sort((left, right) => left.run.bounds.left - right.run.bounds.left)
  );
}

function isAdjacent(previousRight: number, nextLeft: number, reference: PdfBounds): boolean {
  const height = Math.max(1, reference.top - reference.bottom);
  const gap = nextLeft - previousRight;
  return gap >= -1 && gap <= Math.max(2, height * 0.25);
}

function isDigitText(text: string): boolean {
  return /^\d+$/.test(normalizePdfText(text));
}

function normalizePdfText(text: string): string {
  return text.normalize("NFKC").replace(/￥/g, "¥").trim();
}

function horizontalSide(bounds: PdfBounds, view: PdfBounds): "left" | "right" | null {
  const verticallyInside = bounds.bottom >= view.bottom && bounds.top <= view.top;
  if (!verticallyInside) return null;
  if (bounds.right <= view.left) return "left";
  if (bounds.left >= view.right) return "right";
  return null;
}

function intersectsView(bounds: PdfBounds, view: PdfBounds): boolean {
  return bounds.right > view.left && bounds.left < view.right && bounds.top > view.bottom && bounds.bottom < view.top;
}

function uniqueEvidence(evidence: readonly PdfEdgeOverflowMenuEvidence[]): {
  unique: PdfEdgeOverflowMenuEvidence[];
  duplicate: boolean;
} {
  const seen = new Set<string>();
  const unique: PdfEdgeOverflowMenuEvidence[] = [];
  let duplicate = false;
  for (const item of evidence) {
    const key = `${item.page}:${Math.round(item.baselineY)}:${item.side}:${item.name}:${item.priceYen}`;
    if (seen.has(key)) {
      duplicate = true;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return { unique, duplicate };
}

function unionBounds(bounds: readonly PdfBounds[]): PdfBounds {
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    bottom: Math.min(...bounds.map((item) => item.bottom)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.max(...bounds.map((item) => item.top))
  };
}
