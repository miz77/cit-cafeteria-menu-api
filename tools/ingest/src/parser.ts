import {
  createEmptyLocationMenu,
  LOCATIONS,
  type LocationId,
  type LocationMenu,
  type LocationStatus
} from "@cit-cafeteria/schema";
import { inferDateFromMonthDay, mondayWeekStart, parseDateOnly } from "./dates";
import type { FetchedPdf, PdfExtraction, PdfLimits, PdfTextItem } from "./pdf";
import type { IngestSource } from "./sources";
import { type ColumnRow, structureMenuRows } from "./structure";

export interface LocationParseResult {
  locationId: LocationId;
  source: IngestSource;
  sourceInfo: LocationMenu["source"];
  status: LocationStatus;
  statusMessage: string;
  warnings: string[];
  menusByDate: Map<string, LocationMenu>;
  closedDates: Map<string, string>;
}

interface DateHeader {
  date: string;
  x: number;
  y: number;
  page: number;
  item: PdfTextItem;
}

export function parseLocationPdf(
  pdf: FetchedPdf,
  extraction: PdfExtraction,
  limits: PdfLimits,
  referenceDate: string
): LocationParseResult {
  const sourceInfo = {
    sourcePageUrl: pdf.source.sourcePageUrl,
    pdfUrl: pdf.source.pdfUrl,
    fetchedAt: pdf.fetchedAt,
    sha256: pdf.sha256
  };
  const warnings = [...pdf.warnings, ...extraction.warnings];

  if (extraction.pageCount !== limits.expectedPagesPerPdf) {
    if (extraction.pageCount > limits.maxPagesPerPdf) warnings.push("source_pdf_page_hard_limit_exceeded");
    return failedResult(
      pdf.source,
      sourceInfo,
      "source_changed",
      `Expected 1 PDF page, got ${extraction.pageCount}.`,
      warnings
    );
  }

  if (extraction.items.length > limits.maxTextItemsPerPdf) {
    return failedResult(pdf.source, sourceInfo, "source_changed", "PDF text item count exceeded the parser limit.", [
      ...warnings,
      "source_pdf_text_item_limit_exceeded"
    ]);
  }

  const headers = detectDateHeaders(extraction.items, referenceDate);
  if (headers.length === 0) {
    return failedResult(pdf.source, sourceInfo, "parse_failed", "No date headers were detected.", warnings);
  }

  const menusByDate = new Map<string, LocationMenu>();
  const { columns, blockCount } = computeHeaderColumns(headers);
  const closedDates = detectClosedDates(extraction.items, headers);
  if (blockCount > 1) {
    warnings.push("multi_block_layout_detected");
  }

  for (const { header, left, right, labelLeft, labelRight } of columns) {
    const rows = extractColumnRows(extraction.items, header, left, right);
    const rawLines = rows.map((row) => row.text);
    const {
      rawText,
      lines,
      warnings: lineWarnings
    } = normalizeLines(rawLines, limits.maxRawTextCharsPerLocationPerDate);
    const status = statusForRawText(rawText);
    const locationWarnings = [...warnings, ...lineWarnings];
    const structured =
      status === "ok"
        ? structureMenuRows(rows, extractColumnRows(extraction.items, header, labelLeft, labelRight))
        : { menuItems: [], unassignedLines: lines };

    menusByDate.set(header.date, {
      ...locationBase(pdf.source.locationId),
      status,
      statusMessage: status === "ok" ? undefined : statusMessageFor(status),
      menuText: {
        format: "plain_text",
        rawText,
        lines
      },
      menuItems: structured.menuItems,
      unassignedLines: structured.unassignedLines,
      parser: {
        version: "simple-column-v2",
        confidence: confidenceFor(status, locationWarnings),
        warnings: locationWarnings
      },
      source: sourceInfo
    });
  }

  return {
    locationId: pdf.source.locationId,
    source: pdf.source,
    sourceInfo,
    status: "ok",
    statusMessage: "Parsed PDF date columns.",
    warnings,
    menusByDate,
    closedDates
  };
}

export function failedLocationResult(
  source: IngestSource,
  status: LocationStatus,
  statusMessage: string,
  warnings: string[] = []
): LocationParseResult {
  return failedResult(
    source,
    {
      sourcePageUrl: source.sourcePageUrl,
      pdfUrl: source.pdfUrl
    },
    status,
    statusMessage,
    [...source.warnings, ...warnings]
  );
}

export function fallbackLocationMenu(result: LocationParseResult, date: string): LocationMenu {
  if (result.status === "ok") {
    const closedReason = result.closedDates.get(date);
    if (closedReason) {
      return createEmptyLocationMenu(
        result.locationId,
        "closed",
        `The source indicates this location is closed on ${date}: ${closedReason}.`,
        result.sourceInfo,
        result.warnings
      );
    }

    return createEmptyLocationMenu(
      result.locationId,
      "not_published",
      `No menu was published for ${date}.`,
      result.sourceInfo,
      result.warnings
    );
  }

  return createEmptyLocationMenu(
    result.locationId,
    result.status,
    result.statusMessage,
    result.sourceInfo,
    result.warnings
  );
}

function failedResult(
  source: IngestSource,
  sourceInfo: LocationMenu["source"],
  status: LocationStatus,
  statusMessage: string,
  warnings: string[]
): LocationParseResult {
  return {
    locationId: source.locationId,
    source,
    sourceInfo,
    status,
    statusMessage,
    warnings,
    menusByDate: new Map(),
    closedDates: new Map()
  };
}

function detectDateHeaders(items: PdfTextItem[], referenceDate: string): DateHeader[] {
  const headers: DateHeader[] = [];
  let currentMonth = Number(referenceDate.slice(5, 7));
  let previousDay: number | null = null;
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);

  for (const item of sorted) {
    const normalized = normalizeText(item.text);
    for (const match of dateMatches(normalized)) {
      if (match.month) {
        currentMonth = match.month;
      } else if (previousDay !== null && match.day < previousDay) {
        currentMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      }
      const month = match.month ?? currentMonth;
      const date = inferDateFromMonthDay(month, match.day, referenceDate);
      previousDay = match.day;
      if (headers.some((header) => header.date === date && Math.abs(header.x - item.x) < 2)) continue;
      headers.push({
        date,
        x: item.x + item.width / 2,
        y: item.y,
        page: item.page,
        item
      });
    }
  }

  return headers.sort((a, b) => a.date.localeCompare(b.date));
}

function dateMatches(text: string): Array<{ month?: number; day: number }> {
  const matches: Array<{ month?: number; day: number }> = [];

  const monthDayPattern = /(?:(\d{1,2})月)?(\d{1,2})日(?:[（(][日月火水木金土][）)])?/g;
  let monthDayMatch: RegExpExecArray | null;
  while ((monthDayMatch = monthDayPattern.exec(text))) {
    matches.push({
      month: monthDayMatch[1] ? Number(monthDayMatch[1]) : undefined,
      day: Number(monthDayMatch[2])
    });
  }

  const slashPattern = /(\d{1,2})\/(\d{1,2})(?:[（(][日月火水木金土][）)])?/g;
  let slashMatch: RegExpExecArray | null;
  while ((slashMatch = slashPattern.exec(text))) {
    matches.push({
      month: Number(slashMatch[1]),
      day: Number(slashMatch[2])
    });
  }

  const dayWithWeekdayPattern = /(?<![\d/])(\d{1,2})[（(][日月火水木金土][）)]/g;
  let dayWithWeekdayMatch: RegExpExecArray | null;
  while ((dayWithWeekdayMatch = dayWithWeekdayPattern.exec(text))) {
    matches.push({
      day: Number(dayWithWeekdayMatch[1])
    });
  }

  return matches.filter(
    (match) => match.day >= 1 && match.day <= 31 && (!match.month || (match.month >= 1 && match.month <= 12))
  );
}

interface HeaderColumn {
  header: DateHeader;
  left: number;
  right: number;
  labelLeft: number;
  labelRight: number;
}

// Menu PDFs are usually one week-block wide, but occasionally hold two blocks
// side by side with a row-label gutter between them. Splitting columns at the
// midpoint across that gutter would assign the gutter labels to the last date
// of the left block, so block-edge columns are closed at half the median
// header gap instead.
const BLOCK_GAP_RATIO = 1.45;

function computeHeaderColumns(headers: DateHeader[]): { columns: HeaderColumn[]; blockCount: number } {
  const sorted = [...headers].sort((a, b) => a.x - b.x);
  const gaps = sorted.slice(1).map((header, index) => header.x - sorted[index].x);

  if (gaps.length === 0) {
    return {
      columns: sorted.map((header) => ({
        header,
        left: Number.NEGATIVE_INFINITY,
        right: Number.POSITIVE_INFINITY,
        labelLeft: Number.NEGATIVE_INFINITY,
        labelRight: Number.NEGATIVE_INFINITY
      })),
      blockCount: 1
    };
  }

  const blockGapThreshold = median(gaps) * BLOCK_GAP_RATIO;
  const blocks: DateHeader[][] = [[sorted[0]]];
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].x - sorted[index - 1].x > blockGapThreshold) blocks.push([]);
    blocks[blocks.length - 1].push(sorted[index]);
  }

  // Cell width comes from intra-block gaps only, so a wide inter-block gap
  // cannot skew the closure of block-edge columns.
  const intraBlockGaps = gaps.filter((gap) => gap <= blockGapThreshold);
  const cellGap = intraBlockGaps.length > 0 ? median(intraBlockGaps) : median(gaps);

  const columns: HeaderColumn[] = [];
  let previousBlockRight = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    const blockLeft = block[0].x - cellGap / 2;
    const blockRight = block[block.length - 1].x + cellGap / 2;
    for (let index = 0; index < block.length; index += 1) {
      const header = block[index];
      columns.push({
        header,
        left: index === 0 ? header.x - cellGap / 2 : midpoint(block[index - 1].x, header.x),
        right: index === block.length - 1 ? header.x + cellGap / 2 : midpoint(header.x, block[index + 1].x),
        labelLeft: previousBlockRight,
        labelRight: blockLeft
      });
    }
    previousBlockRight = blockRight;
  }

  return { columns, blockCount: blocks.length };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function extractColumnLines(items: PdfTextItem[], header: DateHeader, left: number, right: number): string[] {
  return extractColumnRows(items, header, left, right).map((row) => row.text);
}

function extractColumnRows(items: PdfTextItem[], header: DateHeader, left: number, right: number): ColumnRow[] {
  const candidates = items
    .filter((item) => item.page === header.page)
    .filter((item) => item !== header.item)
    .filter((item) => item.x + item.width / 2 >= left && item.x + item.width / 2 < right)
    .filter((item) => item.y < header.y - 2)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const grouped: Array<{ y: number; texts: Array<{ x: number; text: string }> }> = [];
  for (const item of candidates) {
    const text = normalizeText(item.text);
    if (!text) continue;
    const existing = grouped.find((group) => Math.abs(group.y - item.y) <= 3);
    if (existing) {
      existing.texts.push({ x: item.x, text });
      existing.y = (existing.y + item.y) / 2;
    } else {
      grouped.push({ y: item.y, texts: [{ x: item.x, text }] });
    }
  }

  return grouped.map((group) => {
    const texts = group.texts.sort((a, b) => a.x - b.x).map((item) => item.text);
    return {
      y: group.y,
      texts,
      text: texts.join(" ")
    };
  });
}

function normalizeLines(
  lines: string[],
  maxChars: number
): { rawText: string | null; lines: string[]; warnings: string[] } {
  const normalizedLines = lines.map((line) => normalizeText(line)).filter(Boolean);
  let rawText = normalizedLines.join("\n").trim();
  const warnings: string[] = [];

  if (rawText.length > maxChars) {
    rawText = rawText.slice(0, maxChars);
    warnings.push("raw_text_truncated");
  }

  return {
    rawText: rawText || null,
    lines: rawText ? rawText.split("\n") : [],
    warnings
  };
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function statusForRawText(rawText: string | null): LocationStatus {
  if (!rawText) return "not_published";
  const statusText = rawText
    .split("\n")
    .filter((line) => !isWeekdayClosedNotice(line))
    .join("\n");
  if (/(休業|休み|閉店|定休日|closed)/i.test(statusText)) return "closed";
  return "ok";
}

const WEEKDAY_INDEX_BY_JA = new Map([
  ["日", 0],
  ["月", 1],
  ["火", 2],
  ["水", 3],
  ["木", 4],
  ["金", 5],
  ["土", 6]
]);

function detectClosedDates(items: readonly PdfTextItem[], headers: readonly DateHeader[]): Map<string, string> {
  const closedWeekdays = new Map<number, string>();
  for (const item of items) {
    const text = normalizeText(item.text);
    const match = text.match(/^([日月火水木金土])曜日休業$/);
    if (!match) continue;
    const weekday = WEEKDAY_INDEX_BY_JA.get(match[1]);
    if (weekday === undefined) continue;
    closedWeekdays.set(weekday, text);
  }

  const closedDates = new Map<string, string>();
  if (closedWeekdays.size === 0) return closedDates;

  const headerDates = new Set(headers.map((header) => header.date));
  const weekStarts = Array.from(new Set(headers.map((header) => mondayWeekStart(header.date))));
  for (const weekStart of weekStarts) {
    for (const [weekday, reason] of closedWeekdays) {
      const date = dateForWeekday(weekStart, weekday);
      if (!headerDates.has(date)) closedDates.set(date, reason);
    }
  }

  return closedDates;
}

function dateForWeekday(weekStart: string, weekday: number): string {
  const date = parseDateOnly(weekStart);
  date.setUTCDate(date.getUTCDate() + ((weekday + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function isWeekdayClosedNotice(text: string): boolean {
  return /^[日月火水木金土]曜日休業$/.test(normalizeText(text));
}

function statusMessageFor(status: LocationStatus): string {
  if (status === "closed") return "The source indicates this location is closed or has no service.";
  if (status === "not_published") return "No menu text was found for this date.";
  return `Location status is ${status}.`;
}

function confidenceFor(status: LocationStatus, warnings: string[]): number {
  if (status === "ok") return warnings.length ? 0.78 : 0.9;
  if (status === "closed") return 0.8;
  return 0.3;
}

function locationBase(locationId: LocationId) {
  const location = LOCATIONS.find((candidate) => candidate.id === locationId);
  if (!location) throw new Error(`Unknown locationId: ${locationId}`);
  return location;
}

function midpoint(left: number, right: number): number {
  return left + (right - left) / 2;
}

export const __test__ = {
  detectDateHeaders,
  extractColumnLines,
  extractColumnRows,
  dateMatches,
  computeHeaderColumns,
  statusForRawText
};
