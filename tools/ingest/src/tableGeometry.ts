import type { PdfTextItem } from "./pdf";
import type { PdfPageGeometry, PdfRuling } from "./pdfRulings";

export interface DateColumnGeometry {
  page: number;
  left: number;
  right: number;
}

export interface ColumnSpan {
  firstColumn: number;
  lastColumnExclusive: number;
}

export interface ColumnSpanResult {
  spansByItemIndex: Map<number, ColumnSpan>;
  ambiguousItemIndexes: number[];
  warnings: string[];
}

interface RowBand {
  bottom: number;
  top: number;
}

interface BoundaryEvidence {
  position: number;
  rulings: PdfRuling[];
}

const COLUMN_SNAP_TOLERANCE = 3;
const BAND_ENDPOINT_TOLERANCE = 2.5;
const MAX_ROW_BOUNDARY_DISTANCE = 35;
const COLUMN_CONTIGUITY_TOLERANCE = 5;

export function inferMergedColumnSpans(
  items: readonly PdfTextItem[],
  columns: readonly DateColumnGeometry[],
  pages: readonly PdfPageGeometry[],
  options: { excludedItemIndexes?: ReadonlySet<number> } = {}
): ColumnSpanResult {
  const spansByItemIndex = new Map<number, ColumnSpan>();
  const ambiguousItemIndexes: number[] = [];
  const warnings: string[] = [];
  const pageByNumber = new Map(pages.map((page) => [page.page, page]));

  for (const group of contiguousColumnGroups(columns)) {
    const page = pageByNumber.get(group.columns[0].page);
    if (!page || group.columns.some((column) => column.page !== page.page)) continue;
    const boundaries = columnBoundaries(group.columns);
    if (!boundaries || boundaries.some((boundary) => !Number.isFinite(boundary))) continue;
    const evidence = boundaries.map((position) => boundaryEvidence(position, page.rulings));

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      if (options.excludedItemIndexes?.has(itemIndex)) continue;
      const item = items[itemIndex];
      if (item.page !== page.page) continue;
      const center = item.x + item.width / 2;
      const baseColumn = group.columns.findIndex((column) => center >= column.left && center < column.right);
      if (baseColumn < 0) continue;

      const band = inferRowBand(item, page.rulings);
      if (!band) continue;
      const hasMissingAdjacentBoundary =
        !crossesBand(evidence[baseColumn], band) || !crossesBand(evidence[baseColumn + 1], band);
      const localSpan = resolvePhysicalSpan(baseColumn, band, boundaries, evidence, page.rulings);
      if (!localSpan) {
        if (hasMissingAdjacentBoundary) {
          ambiguousItemIndexes.push(itemIndex);
          pushUnique(warnings, "ambiguous_column_span_not_expanded");
        }
        continue;
      }
      if (localSpan.lastColumnExclusive - localSpan.firstColumn <= 1) continue;
      if (
        hasCompetingColumnItem(
          itemIndex,
          item,
          baseColumn,
          localSpan,
          band,
          items,
          group.columns,
          options.excludedItemIndexes
        )
      ) {
        ambiguousItemIndexes.push(itemIndex);
        pushUnique(warnings, "ambiguous_column_span_not_expanded");
        continue;
      }

      spansByItemIndex.set(itemIndex, {
        firstColumn: group.startIndex + localSpan.firstColumn,
        lastColumnExclusive: group.startIndex + localSpan.lastColumnExclusive
      });
    }
  }

  return { spansByItemIndex, ambiguousItemIndexes, warnings };
}

function hasCompetingColumnItem(
  itemIndex: number,
  item: PdfTextItem,
  baseColumn: number,
  span: ColumnSpan,
  band: RowBand,
  items: readonly PdfTextItem[],
  columns: readonly DateColumnGeometry[],
  excludedItemIndexes: ReadonlySet<number> | undefined
): boolean {
  return items.some((candidate, candidateIndex) => {
    if (candidateIndex === itemIndex || excludedItemIndexes?.has(candidateIndex) || candidate.page !== item.page) {
      return false;
    }
    if (candidate.y >= band.top || candidate.y + candidate.height <= band.bottom) return false;
    const center = candidate.x + candidate.width / 2;
    const candidateColumn = columns.findIndex((column) => center >= column.left && center < column.right);
    return (
      candidateColumn >= span.firstColumn &&
      candidateColumn < span.lastColumnExclusive &&
      candidateColumn !== baseColumn
    );
  });
}

function resolvePhysicalSpan(
  baseColumn: number,
  band: RowBand,
  boundaries: readonly number[],
  evidence: readonly BoundaryEvidence[],
  rulings: readonly PdfRuling[]
): ColumnSpan | null {
  let leftBoundary = baseColumn;
  while (leftBoundary >= 0 && !crossesBand(evidence[leftBoundary], band)) leftBoundary -= 1;
  let rightBoundary = baseColumn + 1;
  while (rightBoundary < boundaries.length && !crossesBand(evidence[rightBoundary], band)) rightBoundary += 1;

  if (leftBoundary < 0 || rightBoundary >= boundaries.length || rightBoundary - leftBoundary <= 1) return null;
  if (!horizontalBoundaryConnects(band.bottom, boundaries[leftBoundary], boundaries[rightBoundary], rulings))
    return null;
  if (!horizontalBoundaryConnects(band.top, boundaries[leftBoundary], boundaries[rightBoundary], rulings)) return null;

  for (let boundary = leftBoundary + 1; boundary < rightBoundary; boundary += 1) {
    if (!provesMergedBoundary(evidence[boundary], band)) return null;
  }

  return { firstColumn: leftBoundary, lastColumnExclusive: rightBoundary };
}

function provesMergedBoundary(evidence: BoundaryEvidence, band: RowBand): boolean {
  if (crossesBand(evidence, band)) return false;
  const repeated = evidence.rulings.length >= 2;
  const strokeSupported = evidence.rulings.some((ruling) => ruling.source === "stroke");
  const repeatedThinFill = evidence.rulings.filter((ruling) => ruling.source === "thin_fill").length >= 2;
  if (!repeated || (!strokeSupported && !repeatedThinFill)) return false;

  return evidence.rulings.some(
    (ruling) =>
      Math.abs(ruling.end - band.bottom) <= BAND_ENDPOINT_TOLERANCE ||
      Math.abs(ruling.start - band.top) <= BAND_ENDPOINT_TOLERANCE
  );
}

function crossesBand(evidence: BoundaryEvidence, band: RowBand): boolean {
  return evidence.rulings.some(
    (ruling) =>
      ruling.start <= band.bottom + BAND_ENDPOINT_TOLERANCE && ruling.end >= band.top - BAND_ENDPOINT_TOLERANCE
  );
}

function inferRowBand(item: PdfTextItem, rulings: readonly PdfRuling[]): RowBand | null {
  const horizontal = rulings.filter(
    (ruling) =>
      ruling.orientation === "horizontal" &&
      ruling.start <= item.x + item.width / 2 &&
      ruling.end >= item.x + item.width / 2
  );
  const below = horizontal
    .filter((ruling) => ruling.position <= item.y + BAND_ENDPOINT_TOLERANCE)
    .sort((a, b) => b.position - a.position)[0];
  const above = horizontal
    .filter((ruling) => ruling.position >= item.y + item.height - BAND_ENDPOINT_TOLERANCE)
    .sort((a, b) => a.position - b.position)[0];
  if (!below || !above || above.position <= below.position) return null;
  if (item.y - below.position > MAX_ROW_BOUNDARY_DISTANCE) return null;
  if (above.position - (item.y + item.height) > MAX_ROW_BOUNDARY_DISTANCE) return null;
  return { bottom: below.position, top: above.position };
}

function horizontalBoundaryConnects(y: number, left: number, right: number, rulings: readonly PdfRuling[]): boolean {
  return rulings.some(
    (ruling) =>
      ruling.orientation === "horizontal" &&
      Math.abs(ruling.position - y) <= BAND_ENDPOINT_TOLERANCE &&
      ruling.start <= left + COLUMN_SNAP_TOLERANCE &&
      ruling.end >= right - COLUMN_SNAP_TOLERANCE
  );
}

function boundaryEvidence(position: number, rulings: readonly PdfRuling[]): BoundaryEvidence {
  return {
    position,
    rulings: rulings.filter(
      (ruling) => ruling.orientation === "vertical" && Math.abs(ruling.position - position) <= COLUMN_SNAP_TOLERANCE
    )
  };
}

function columnBoundaries(columns: readonly DateColumnGeometry[]): number[] | null {
  if (columns.length === 0) return null;
  return [columns[0].left, ...columns.map((column) => column.right)];
}

function contiguousColumnGroups(
  columns: readonly DateColumnGeometry[]
): Array<{ startIndex: number; columns: DateColumnGeometry[] }> {
  const groups: Array<{ startIndex: number; columns: DateColumnGeometry[] }> = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const current = groups.at(-1);
    const previous = current?.columns.at(-1);
    if (
      !current ||
      !previous ||
      previous.page !== column.page ||
      Math.abs(previous.right - column.left) > COLUMN_CONTIGUITY_TOLERANCE
    ) {
      groups.push({ startIndex: index, columns: [column] });
    } else {
      current.columns.push(column);
    }
  }
  return groups;
}

function pushUnique(target: string[], warning: string): void {
  if (!target.includes(warning)) target.push(warning);
}
