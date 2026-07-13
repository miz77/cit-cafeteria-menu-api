import type { PdfBounds } from "./pdfGraphicsState";
import type { PdfOffPageTextGroup } from "./pdfEdgeOverflow";
import { normalizePriceToken, parseSharedPricePairs } from "./sharedPriceTokens";

export interface SharedRowBand {
  id: string;
  page: number;
  minY: number;
  maxY: number;
}

export interface RecoveredSharedRowItem {
  rowId: string;
  name: string;
  priceYen: number;
  side: "left" | "right";
  bounds: PdfBounds;
  sourceRunIndexes: number[];
}

export type SharedRowOverflowDiagnosticCode =
  | "pdf_text_edge_shared_item_recovered"
  | "pdf_text_edge_candidate_unassigned"
  | "pdf_text_edge_candidate_ambiguous"
  | "pdf_text_edge_candidate_incomplete_pair"
  | "pdf_text_edge_candidate_too_far"
  | "pdf_text_edge_candidate_anchor_unverified";

export interface SharedRowOverflowDiagnostic {
  code: SharedRowOverflowDiagnosticCode;
  page: number;
  rowId?: string;
  side: "left" | "right";
  bounds: PdfBounds;
  edgeGap: number;
  maxEdgeGap?: number;
  sourceRunIndexes: number[];
  name?: string;
  priceYen?: number;
}

export interface SharedRowOverflowResolution {
  recoveredByRowId: Map<string, RecoveredSharedRowItem[]>;
  diagnostics: SharedRowOverflowDiagnostic[];
  warnings: string[];
}

interface ValidCandidate {
  group: PdfOffPageTextGroup;
  rowId: string;
  name: string;
  priceYen: number;
  maxEdgeGap: number;
}

const EDGE_GAP_TEXT_HEIGHT_MULTIPLIER = 2;
const EDGE_GAP_VISIBLE_SPACE_MULTIPLIER = 1.5;
const EDGE_GAP_TEXT_HEIGHT_CAP = 4;

export function resolveSharedRowOverflow(
  groups: readonly PdfOffPageTextGroup[],
  bands: readonly SharedRowBand[]
): SharedRowOverflowResolution {
  const recoveredByRowId = new Map<string, RecoveredSharedRowItem[]>();
  const diagnostics: SharedRowOverflowDiagnostic[] = [];
  const warnings = new Set<string>();
  const valid: ValidCandidate[] = [];

  for (const group of groups) {
    const matching = bands.filter(
      (band) => band.page === group.page && group.baselineY >= band.minY && group.baselineY <= band.maxY
    );
    if (matching.length === 0) {
      diagnostics.push(diagnostic("pdf_text_edge_candidate_unassigned", group));
      continue;
    }
    if (matching.length > 1) {
      diagnostics.push(diagnostic("pdf_text_edge_candidate_ambiguous", group));
      warnings.add("pdf_text_edge_candidate_ambiguous");
      continue;
    }

    const rowId = matching[0].id;
    const pairs = parseSharedPricePairs(group.runs.map((run) => run.text));
    const consumed = new Set(pairs.flatMap((pair) => pair.consumedTokenIndexes));
    if (pairs.length !== 1 || consumed.size !== group.runs.length) {
      diagnostics.push(diagnostic("pdf_text_edge_candidate_incomplete_pair", group, rowId));
      if (group.runs.some((run) => /[¥\\]/.test(normalizePriceToken(run.text)))) {
        warnings.add("pdf_text_edge_candidate_incomplete_pair");
      }
      continue;
    }

    const pair = pairs[0];
    if (!typographyMatches(group, pair.nameTokenIndex, pair.priceTokenIndexes)) {
      diagnostics.push(diagnostic("pdf_text_edge_candidate_anchor_unverified", group, rowId));
      warnings.add("pdf_text_edge_candidate_anchor_unverified");
      continue;
    }

    const maxEdgeGap = allowedEdgeGap(group);
    if (group.edgeGap > maxEdgeGap) {
      diagnostics.push({
        ...diagnostic("pdf_text_edge_candidate_too_far", group, rowId),
        maxEdgeGap,
        name: pair.name,
        priceYen: pair.priceYen
      });
      warnings.add("pdf_text_edge_candidate_too_far");
      continue;
    }
    valid.push({ group, rowId, name: pair.name, priceYen: pair.priceYen, maxEdgeGap });
  }

  const candidateCounts = occurrenceCounts(valid.map((candidate) => `${candidate.rowId}:${candidate.group.side}`));
  for (const candidate of valid) {
    const key = `${candidate.rowId}:${candidate.group.side}`;
    if (candidateCounts.get(key) !== 1) {
      diagnostics.push(diagnostic("pdf_text_edge_candidate_ambiguous", candidate.group, candidate.rowId));
      warnings.add("pdf_text_edge_candidate_ambiguous");
      continue;
    }

    const recovered: RecoveredSharedRowItem = {
      rowId: candidate.rowId,
      name: candidate.name,
      priceYen: candidate.priceYen,
      side: candidate.group.side,
      bounds: candidate.group.bounds,
      sourceRunIndexes: candidate.group.runs.map((run) => run.sourceRunIndex)
    };
    const rowItems = recoveredByRowId.get(candidate.rowId) ?? [];
    rowItems.push(recovered);
    recoveredByRowId.set(candidate.rowId, rowItems);
    diagnostics.push({
      ...diagnostic("pdf_text_edge_shared_item_recovered", candidate.group, candidate.rowId),
      maxEdgeGap: candidate.maxEdgeGap,
      name: candidate.name,
      priceYen: candidate.priceYen
    });
  }

  return { recoveredByRowId, diagnostics, warnings: Array.from(warnings) };
}

function typographyMatches(
  group: PdfOffPageTextGroup,
  nameTokenIndex: number,
  priceTokenIndexes: readonly number[]
): boolean {
  const nameRun = group.runs[nameTokenIndex];
  const nameAnchor = group.visibleAnchors.some(
    (anchor) => anchor.fontName === nameRun.fontName && /^.+?[¥\\]/.test(normalizePriceToken(anchor.text))
  );
  if (!nameAnchor) return false;

  const continuationIndexes = priceTokenIndexes.filter((index) => index !== nameTokenIndex);
  return continuationIndexes.every((index) => {
    const priceRun = group.runs[index];
    return group.visibleAnchors.some(
      (anchor) => anchor.fontName === priceRun.fontName && /^\d+$/.test(normalizePriceToken(anchor.text))
    );
  });
}

function allowedEdgeGap(group: PdfOffPageTextGroup): number {
  const heights = [...group.runs, ...group.visibleAnchors]
    .map((run) => run.bounds.top - run.bounds.bottom)
    .filter((value) => Number.isFinite(value) && value > 0);
  const representativeHeight = median(heights) ?? 1;
  const anchors = [...group.visibleAnchors].sort((left, right) => left.bounds.left - right.bounds.left);
  const positiveGaps = anchors
    .slice(1)
    .map((anchor, index) => anchor.bounds.left - anchors[index].bounds.right)
    .filter((gap) => gap > 1);
  const visibleSpacing = median(positiveGaps);
  const spacingAllowance = visibleSpacing === null ? 0 : visibleSpacing * EDGE_GAP_VISIBLE_SPACE_MULTIPLIER;
  return Math.max(
    representativeHeight * EDGE_GAP_TEXT_HEIGHT_MULTIPLIER,
    Math.min(spacingAllowance, representativeHeight * EDGE_GAP_TEXT_HEIGHT_CAP)
  );
}

function diagnostic(
  code: SharedRowOverflowDiagnosticCode,
  group: PdfOffPageTextGroup,
  rowId?: string
): SharedRowOverflowDiagnostic {
  return {
    code,
    page: group.page,
    rowId,
    side: group.side,
    bounds: group.bounds,
    edgeGap: group.edgeGap,
    sourceRunIndexes: group.runs.map((run) => run.sourceRunIndex)
  };
}

function occurrenceCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
