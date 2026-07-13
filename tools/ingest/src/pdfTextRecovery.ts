import type { PdfBounds } from "./pdfGraphicsState";
import type { PdfOperatorTextRun } from "./pdfTextOperators";

export interface PdfPlacementTextItem {
  text: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface RecoveredTextEvidence {
  fullTextBounds: PdfBounds;
  missingGlyphBounds: PdfBounds[];
  clippedBy: "page";
}

export interface PdfTextRecoveryDiagnostic extends RecoveredTextEvidence {
  code: "pdf_text_edge_affix_recovered";
  page: number;
  before: string;
  after: string;
  itemBounds: PdfBounds;
  operatorBounds: PdfBounds;
}

export interface PdfTextRecoveryResult {
  items: PdfPlacementTextItem[];
  diagnostics: PdfTextRecoveryDiagnostic[];
  warnings: string[];
  claimedRunIndexes: number[];
}

interface Candidate {
  itemIndex: number;
  runIndex: number;
  missingBounds: PdfBounds[];
}

const MAX_MISSING_GLYPHS = 2;

export function recoverPageEdgeTextAffixes(
  items: readonly PdfPlacementTextItem[],
  runs: readonly PdfOperatorTextRun[],
  pageView: PdfBounds
): PdfTextRecoveryResult {
  const runIndex = indexRuns(runs);
  const reservedRuns = reserveExactRuns(items, runs, runIndex);
  const candidates: Candidate[] = [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    for (const candidateRunIndex of candidateRunIndexes(item, runIndex)) {
      if (reservedRuns.has(candidateRunIndex)) continue;
      const run = runs[candidateRunIndex];
      if (!samePlacementBucket(item, run)) continue;
      const candidate = affixCandidate(item, run, pageView);
      if (candidate) candidates.push({ itemIndex, runIndex: candidateRunIndex, missingBounds: candidate });
    }
  }

  const itemCounts = occurrenceCounts(candidates.map((candidate) => candidate.itemIndex));
  const runCounts = occurrenceCounts(candidates.map((candidate) => candidate.runIndex));
  const accepted = candidates.filter(
    (candidate) => itemCounts.get(candidate.itemIndex) === 1 && runCounts.get(candidate.runIndex) === 1
  );
  const diagnostics: PdfTextRecoveryDiagnostic[] = [];
  const recovered = items.map((item) => ({ ...item }));

  for (const candidate of accepted) {
    const item = items[candidate.itemIndex];
    const run = runs[candidate.runIndex];
    recovered[candidate.itemIndex].text = run.text;
    diagnostics.push({
      code: "pdf_text_edge_affix_recovered",
      page: item.page,
      before: item.text,
      after: run.text,
      itemBounds: placementBounds(item),
      operatorBounds: run.bounds,
      fullTextBounds: run.bounds,
      missingGlyphBounds: candidate.missingBounds,
      clippedBy: "page"
    });
  }

  const ambiguous = candidates.some(
    (candidate) => itemCounts.get(candidate.itemIndex) !== 1 || runCounts.get(candidate.runIndex) !== 1
  );
  return {
    items: recovered,
    diagnostics,
    warnings: ambiguous ? ["pdf_text_edge_affix_recovery_ambiguous"] : [],
    claimedRunIndexes: Array.from(
      new Set([...reservedRuns, ...candidates.map((candidate) => candidate.runIndex)])
    ).sort((a, b) => a - b)
  };
}

function reserveExactRuns(
  items: readonly PdfPlacementTextItem[],
  runs: readonly PdfOperatorTextRun[],
  runIndex: ReadonlyMap<string, readonly number[]>
): Set<number> {
  const reserved = new Set<number>();
  for (const item of items) {
    for (const candidateRunIndex of candidateRunIndexes(item, runIndex)) {
      const run = runs[candidateRunIndex];
      if (run.text === item.text && samePlacementBucket(item, run) && geometryMatches(item, run.bounds)) {
        reserved.add(candidateRunIndex);
      }
    }
  }
  return reserved;
}

function indexRuns(runs: readonly PdfOperatorTextRun[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    const key = placementKey(run.page, run.fontName, Math.round(run.baselineY));
    const bucket = index.get(key) ?? [];
    bucket.push(runIndex);
    index.set(key, bucket);
  }
  return index;
}

function candidateRunIndexes(item: PdfPlacementTextItem, index: ReadonlyMap<string, readonly number[]>): number[] {
  const tolerance = Math.max(1, item.height * 0.15);
  const candidates: number[] = [];
  for (let baseline = Math.floor(item.y - tolerance); baseline <= Math.ceil(item.y + tolerance); baseline += 1) {
    candidates.push(...(index.get(placementKey(item.page, item.fontName, baseline)) ?? []));
  }
  return candidates;
}

function placementKey(page: number, fontName: string, baseline: number): string {
  return `${page}:${fontName}:${baseline}`;
}

function affixCandidate(item: PdfPlacementTextItem, run: PdfOperatorTextRun, pageView: PdfBounds): PdfBounds[] | null {
  if (run.text === item.text || run.glyphs.length <= 1) return null;
  const maximum = Math.min(MAX_MISSING_GLYPHS, run.glyphs.length - 1);

  for (let count = 1; count <= maximum; count += 1) {
    const missingPrefix = run.glyphs.slice(0, count);
    const keptSuffix = run.glyphs.slice(count);
    if (
      keptSuffix.map((glyph) => glyph.text).join("") === item.text &&
      geometryMatches(item, unionBounds(keptSuffix.map((glyph) => glyph.bounds))) &&
      missingPrefix.every((glyph) => whollyOutside(glyph.bounds, pageView))
    ) {
      return missingPrefix.map((glyph) => glyph.bounds);
    }

    const keptPrefix = run.glyphs.slice(0, -count);
    const missingSuffix = run.glyphs.slice(-count);
    if (
      keptPrefix.map((glyph) => glyph.text).join("") === item.text &&
      geometryMatches(item, unionBounds(keptPrefix.map((glyph) => glyph.bounds))) &&
      missingSuffix.every((glyph) => whollyOutside(glyph.bounds, pageView))
    ) {
      return missingSuffix.map((glyph) => glyph.bounds);
    }
  }

  return null;
}

function samePlacementBucket(item: PdfPlacementTextItem, run: PdfOperatorTextRun): boolean {
  if (item.page !== run.page || item.fontName !== run.fontName) return false;
  return Math.abs(item.y - run.baselineY) <= Math.max(1, item.height * 0.15);
}

function geometryMatches(item: PdfPlacementTextItem, bounds: PdfBounds): boolean {
  const positionTolerance = Math.max(1, item.height * 0.15);
  const widthTolerance = Math.max(1, item.height * 0.2);
  return Math.abs(item.x - bounds.left) <= positionTolerance && Math.abs(item.width - width(bounds)) <= widthTolerance;
}

function whollyOutside(bounds: PdfBounds, view: PdfBounds): boolean {
  return (
    bounds.right <= view.left || bounds.left >= view.right || bounds.top <= view.bottom || bounds.bottom >= view.top
  );
}

function placementBounds(item: PdfPlacementTextItem): PdfBounds {
  return { left: item.x, bottom: item.y, right: item.x + item.width, top: item.y + item.height };
}

function width(bounds: PdfBounds): number {
  return bounds.right - bounds.left;
}

function occurrenceCounts(values: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function unionBounds(bounds: readonly PdfBounds[]): PdfBounds {
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    bottom: Math.min(...bounds.map((item) => item.bottom)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.max(...bounds.map((item) => item.top))
  };
}
