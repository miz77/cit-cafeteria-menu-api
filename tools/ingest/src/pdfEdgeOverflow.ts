import type { PdfBounds } from "./pdfGraphicsState";
import type { PdfOperatorTextRun } from "./pdfTextOperators";
import type { PdfTextRunClaims } from "./pdfTextRecovery";

export interface PdfEdgeTextRunEvidence {
  text: string;
  fontName: string;
  bounds: PdfBounds;
  sourceRunIndex: number;
}

export interface PdfOffPageTextGroup {
  page: number;
  side: "left" | "right";
  baselineY: number;
  bounds: PdfBounds;
  edgeGap: number;
  runs: PdfEdgeTextRunEvidence[];
  visibleAnchors: PdfEdgeTextRunEvidence[];
}

export interface PdfEdgeCandidateDiagnostic {
  code: "pdf_text_edge_candidate_detected";
  page: number;
  side: "left" | "right";
  bounds: PdfBounds;
  edgeGap: number;
  sourceRunIndexes: number[];
}

export interface PdfEdgeOverflowResult {
  groups: PdfOffPageTextGroup[];
  diagnostics: PdfEdgeCandidateDiagnostic[];
  warnings: string[];
}

interface IndexedRun {
  index: number;
  run: PdfOperatorTextRun;
}

const MAX_EDGE_EVIDENCE_RUNS_PER_PAGE = 30_000;

/**
 * Preserves only the nearest connected off-page operator group for each
 * page/baseline/side. Menu semantics remain the parser's responsibility.
 */
export function collectPdfEdgeOverflowEvidence(
  runs: readonly PdfOperatorTextRun[],
  pageView: PdfBounds,
  claims: PdfTextRunClaims
): PdfEdgeOverflowResult {
  const matchedVisible = new Set(claims.matchedVisibleRunIndexes);
  const unavailable = new Set([...claims.matchedVisibleRunIndexes, ...claims.blockedRunIndexes]);
  const indexed = runs.map((run, index) => ({ run, index }));
  const outside = indexed.filter(
    ({ index, run }) => !unavailable.has(index) && horizontalSide(run.bounds, pageView) !== null
  );
  if (outside.length > MAX_EDGE_EVIDENCE_RUNS_PER_PAGE) {
    return { groups: [], diagnostics: [], warnings: ["pdf_edge_text_evidence_limit_exceeded"] };
  }

  const visibleAnchors = indexed.filter(
    ({ index, run }) => matchedVisible.has(index) && intersectsView(run.bounds, pageView)
  );
  const groups = clusterOutsideLines(outside, pageView).map((line) =>
    nearestConnectedGroup(line, visibleAnchors, pageView)
  );

  return {
    groups,
    diagnostics: groups.map((group) => ({
      code: "pdf_text_edge_candidate_detected",
      page: group.page,
      side: group.side,
      bounds: group.bounds,
      edgeGap: group.edgeGap,
      sourceRunIndexes: group.runs.map((run) => run.sourceRunIndex)
    })),
    warnings: []
  };
}

function clusterOutsideLines(outside: readonly IndexedRun[], view: PdfBounds): IndexedRun[][] {
  const sorted = [...outside].sort((left, right) => {
    const page = left.run.page - right.run.page;
    if (page !== 0) return page;
    const leftSide = horizontalSide(left.run.bounds, view) ?? "left";
    const rightSide = horizontalSide(right.run.bounds, view) ?? "left";
    const side = leftSide.localeCompare(rightSide);
    if (side !== 0) return side;
    return left.run.baselineY - right.run.baselineY || left.run.bounds.left - right.run.bounds.left;
  });
  const lines: IndexedRun[][] = [];
  for (const entry of sorted) {
    const previous = lines.at(-1);
    if (previous && belongsToLine(previous, entry, view)) previous.push(entry);
    else lines.push([entry]);
  }
  return lines;
}

function belongsToLine(line: readonly IndexedRun[], entry: IndexedRun, view: PdfBounds): boolean {
  const first = line[0].run;
  if (first.page !== entry.run.page) return false;
  if (horizontalSide(first.bounds, view) !== horizontalSide(entry.run.bounds, view)) return false;
  const tolerance = Math.max(0.75, Math.min(height(first.bounds), height(entry.run.bounds)) * 0.08);
  return Math.abs(first.baselineY - entry.run.baselineY) <= tolerance;
}

function nearestConnectedGroup(
  line: readonly IndexedRun[],
  visibleAnchors: readonly IndexedRun[],
  view: PdfBounds
): PdfOffPageTextGroup {
  const sorted = [...line].sort((left, right) => left.run.bounds.left - right.run.bounds.left);
  const side = horizontalSide(sorted[0].run.bounds, view) ?? "left";
  let start = side === "left" ? sorted.length - 1 : 0;
  let end = start;
  if (side === "left") {
    while (start > 0 && connected(sorted[start - 1].run.bounds, sorted[start].run.bounds)) start -= 1;
  } else {
    while (end + 1 < sorted.length && connected(sorted[end].run.bounds, sorted[end + 1].run.bounds)) end += 1;
  }

  const selected = sorted.slice(start, end + 1);
  const bounds = unionBounds(selected.map(({ run }) => run.bounds));
  const baselineY = selected.reduce((sum, { run }) => sum + run.baselineY, 0) / selected.length;
  const anchors = visibleAnchors
    .filter(({ run }) => sameLine(run, selected[0].run))
    .sort((left, right) => left.run.bounds.left - right.run.bounds.left);
  return {
    page: selected[0].run.page,
    side,
    baselineY,
    bounds,
    edgeGap: side === "left" ? Math.max(0, view.left - bounds.right) : Math.max(0, bounds.left - view.right),
    runs: selected.map(toEvidence),
    visibleAnchors: anchors.map(toEvidence)
  };
}

function connected(left: PdfBounds, right: PdfBounds): boolean {
  const gap = right.left - left.right;
  const referenceHeight = Math.max(1, Math.min(height(left), height(right)));
  return gap >= -1 && gap <= Math.max(2, referenceHeight * 0.25);
}

function sameLine(left: PdfOperatorTextRun, right: PdfOperatorTextRun): boolean {
  if (left.page !== right.page) return false;
  const tolerance = Math.max(0.75, Math.min(height(left.bounds), height(right.bounds)) * 0.08);
  return Math.abs(left.baselineY - right.baselineY) <= tolerance;
}

function toEvidence({ index, run }: IndexedRun): PdfEdgeTextRunEvidence {
  return { text: run.text, fontName: run.fontName, bounds: run.bounds, sourceRunIndex: index };
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

function height(bounds: PdfBounds): number {
  return bounds.top - bounds.bottom;
}

function unionBounds(bounds: readonly PdfBounds[]): PdfBounds {
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    bottom: Math.min(...bounds.map((item) => item.bottom)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.max(...bounds.map((item) => item.top))
  };
}
