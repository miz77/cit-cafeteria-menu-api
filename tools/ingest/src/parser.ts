import {
  createEmptyLocationMenu,
  LOCATIONS,
  type LocationId,
  type LocationMenu,
  type LocationStatus,
  type MenuCategory,
  type MenuItem
} from "@cit-cafeteria/schema";
import { inferDateFromMonthDay, mondayWeekStart, parseDateOnly } from "./dates";
import type { FetchedPdf, PdfExtraction, PdfLimits, PdfTextItem } from "./pdf";
import type { IngestSource } from "./sources";
import { type ColumnRow, DEFAULT_STRUCTURE_PROFILE, type StructureProfile, structureMenuRows } from "./structure";

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

interface LocationParserProfile {
  structure: StructureProfile;
  metaOnlyStatus?: LocationStatus;
  sharedRows?: readonly SharedRowProfile[];
  dailyRows?: readonly DailyRowProfile[];
}

interface ExtractColumnRowsOptions {
  bottomY?: number;
  excludeYRanges?: readonly YRange[];
}

interface YRange {
  min: number;
  max: number;
}

interface SharedRowProfile {
  label: string;
  category: MenuCategory;
  categoryLabel: string;
  labelMaxX: number;
  maxAbove: number;
  maxBelow: number;
  warningSlug: string;
  columnBottomMargin?: number;
}

interface DailyRowProfile {
  label: string;
  category: MenuCategory;
  categoryLabel: string;
  maxAbove: number;
  maxBelow: number;
  warningSlug: string;
}

const DEFAULT_LOCATION_PROFILE: LocationParserProfile = {
  structure: DEFAULT_STRUCTURE_PROFILE
};

const SHINNARASHINO_STRUCTURE_PROFILE: StructureProfile = {
  ...DEFAULT_STRUCTURE_PROFILE,
  categoryByLabel: [
    ...DEFAULT_STRUCTURE_PROFILE.categoryByLabel,
    { pattern: /^定食$/, category: "teishoku", label: "定食" },
    { pattern: /^丼$/, category: "donburi", label: "丼" },
    { pattern: /^カレー$/, category: "curry", label: "カレー" },
    { pattern: /^パスタ$/, category: "keishoku_pasta", label: "パスタ" },
    { pattern: /^小鉢$/, category: "side_dish", label: "小鉢" },
    { pattern: /^グルメン$/, category: "men_corner", label: "グルメン" }
  ],
  metaLinePatterns: [...DEFAULT_STRUCTURE_PROFILE.metaLinePatterns, /^営業中$/, /^ラーメン販売$/, /^ありません$/],
  labelPriceMaxGap: 45,
  labelMaxNameAbove: 50,
  labelMaxNameDepth: 58,
  labelBandBoundary: "label",
  clearPriceWarningsWhenCellPriceFound: true
};

const SHINNARASHINO_1F_PROFILE: LocationParserProfile = {
  structure: SHINNARASHINO_STRUCTURE_PROFILE,
  metaOnlyStatus: "not_published",
  sharedRows: [
    {
      label: "カレー",
      category: "curry",
      categoryLabel: "カレー",
      labelMaxX: 80,
      maxAbove: 6,
      maxBelow: 5,
      warningSlug: "shared:curry"
    },
    {
      label: "単品",
      category: "side_dish",
      categoryLabel: "単品",
      labelMaxX: 80,
      maxAbove: 5,
      maxBelow: 5,
      warningSlug: "shared:side_dish",
      columnBottomMargin: 4
    }
  ],
  dailyRows: [
    {
      label: "グルメン",
      category: "men_corner",
      categoryLabel: "グルメン",
      maxAbove: 65,
      maxBelow: 40,
      warningSlug: "daily:men_corner"
    }
  ]
};

const SHINNARASHINO_2F_PROFILE: LocationParserProfile = {
  structure: SHINNARASHINO_STRUCTURE_PROFILE,
  metaOnlyStatus: "not_published",
  sharedRows: [
    {
      label: "小鉢",
      category: "side_dish",
      categoryLabel: "小鉢",
      labelMaxX: 80,
      maxAbove: 12,
      maxBelow: 75,
      warningSlug: "shared:side_dish",
      columnBottomMargin: 20
    }
  ]
};

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
  const profile = profileForLocation(pdf.source.locationId);

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
  const sharedRows = collectSharedRows(extraction.items, profile);
  const profileWarnings = [...sharedRows.warnings];
  if (blockCount > 1) {
    warnings.push("multi_block_layout_detected");
  }

  for (const { header, left, right, labelLeft, labelRight } of columns) {
    const rows = extractColumnRows(extraction.items, header, left, right, {
      bottomY: sharedRows.columnBottomY,
      excludeYRanges: sharedRows.excludeYRanges
    });
    const labelRows = extractColumnRows(extraction.items, header, labelLeft, labelRight);
    const tableBottomY = inferMenuTableBottomY(labelRows, profile.structure);
    const tableRows = tableBottomY === undefined ? rows : rows.filter((row) => row.y >= tableBottomY);
    const belowTableRows = tableBottomY === undefined ? [] : rows.filter((row) => row.y < tableBottomY);
    const dailyRows = collectDailyRows(tableRows, labelRows, profile);
    pushUniqueWarnings(profileWarnings, dailyRows.warnings);
    const structureRows = tableRows.filter((row) => !isRowInYRanges(row, dailyRows.excludeYRanges));
    const rawLines = rows.map((row) => row.text);
    const {
      rawText,
      lines,
      warnings: lineWarnings
    } = normalizeLines(rawLines, limits.maxRawTextCharsPerLocationPerDate);
    const structured = structureMenuRows(structureRows, labelRows, profile.structure);
    const dailyMenuItems = [...structured.menuItems, ...dailyRows.menuItems];
    const hasStrongDailyMenuEvidence = dailyMenuItems.some(isStrongDailyMenuEvidence);
    const tableRawText = normalizeLines(
      tableRows.map((row) => row.text),
      limits.maxRawTextCharsPerLocationPerDate
    ).rawText;
    const hasClosedNotice = containsClosedNotice(tableRawText);
    const status = statusForRawText(tableRawText, profile, hasStrongDailyMenuEvidence);
    const locationWarnings = uniqueWarnings([
      ...warnings,
      ...sharedRows.warnings,
      ...dailyRows.warnings,
      ...lineWarnings,
      ...(hasStrongDailyMenuEvidence && hasClosedNotice ? ["closed_notice_conflicts_with_daily_menu"] : [])
    ]);
    const menuItems = status === "ok" ? [...dailyMenuItems, ...sharedRows.menuItems] : [];
    const unassignedLines =
      status === "ok" ? [...structured.unassignedLines, ...belowTableRows.map((row) => row.text)] : lines;

    menusByDate.set(header.date, {
      ...locationBase(pdf.source.locationId),
      status,
      statusMessage: status === "ok" ? undefined : statusMessageFor(status),
      menuText: {
        format: "plain_text",
        rawText,
        lines
      },
      menuItems,
      unassignedLines,
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
    warnings: uniqueWarnings([...warnings, ...profileWarnings]),
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

function profileForLocation(locationId: LocationId): LocationParserProfile {
  if (locationId === "shinnarashino-1f") return SHINNARASHINO_1F_PROFILE;
  if (locationId === "shinnarashino-2f") return SHINNARASHINO_2F_PROFILE;
  return DEFAULT_LOCATION_PROFILE;
}

function extractColumnLines(items: PdfTextItem[], header: DateHeader, left: number, right: number): string[] {
  return extractColumnRows(items, header, left, right).map((row) => row.text);
}

function extractColumnRows(
  items: PdfTextItem[],
  header: DateHeader,
  left: number,
  right: number,
  options: ExtractColumnRowsOptions = {}
): ColumnRow[] {
  const candidates = items
    .filter((item) => item.page === header.page)
    .filter((item) => item !== header.item)
    .filter((item) => item.x + item.width / 2 >= left && item.x + item.width / 2 < right)
    .filter((item) => item.y < header.y - 2)
    .filter((item) => options.bottomY === undefined || item.y >= options.bottomY)
    .filter((item) => !options.excludeYRanges?.some((range) => item.y >= range.min && item.y <= range.max))
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

function collectSharedRows(
  items: readonly PdfTextItem[],
  profile: LocationParserProfile
): { menuItems: MenuItem[]; excludeYRanges: YRange[]; warnings: string[]; columnBottomY?: number } {
  const menuItems: MenuItem[] = [];
  const excludeYRanges: YRange[] = [];
  const warnings: string[] = [];
  let columnBottomY: number | undefined;

  for (const rule of profile.sharedRows ?? []) {
    const label = items.find((item) => normalizeText(item.text) === rule.label && item.x <= rule.labelMaxX);
    if (!label) {
      warnings.push(profileRowsNotDetectedWarning(rule.warningSlug));
      continue;
    }

    const range = { min: label.y - rule.maxBelow, max: label.y + rule.maxAbove };
    if (rule.columnBottomMargin !== undefined) {
      const bottomY = range.min - rule.columnBottomMargin;
      columnBottomY = columnBottomY === undefined ? bottomY : Math.min(columnBottomY, bottomY);
    }

    const rowItems = items.filter((item) => item.page === label.page && item.y >= range.min && item.y <= range.max);
    const parsed = parseSharedPriceItems(rowItems, rule);

    excludeYRanges.push(range);
    menuItems.push(...parsed);
  }

  return { menuItems: uniqueMenuItems(menuItems), excludeYRanges, warnings: uniqueWarnings(warnings), columnBottomY };
}

function collectDailyRows(
  rows: readonly ColumnRow[],
  labelRows: readonly ColumnRow[],
  profile: LocationParserProfile
): { menuItems: MenuItem[]; excludeYRanges: YRange[]; warnings: string[] } {
  const menuItems: MenuItem[] = [];
  const excludeYRanges: YRange[] = [];
  const warnings: string[] = [];

  for (const rule of profile.dailyRows ?? []) {
    const labelRow = labelRows.find((row) => normalizeText(row.text) === rule.label);
    if (!labelRow) {
      warnings.push(profileRowsNotDetectedWarning(rule.warningSlug));
      continue;
    }

    const range = { min: labelRow.y - rule.maxBelow, max: labelRow.y + rule.maxAbove };
    const bandRows = rows.filter((row) => row.y >= range.min && row.y <= range.max).sort((a, b) => b.y - a.y);
    const parsed = parseDailyPriceBlocks(bandRows, rule);
    if (parsed.length === 0) continue;

    excludeYRanges.push(range);
    menuItems.push(...parsed);
  }

  return { menuItems, excludeYRanges, warnings: uniqueWarnings(warnings) };
}

function parseDailyPriceBlocks(rows: readonly ColumnRow[], rule: DailyRowProfile): MenuItem[] {
  const menuItems: MenuItem[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const price = parsePriceOnly(row.text);
    if (price === null) continue;

    const nameRows: string[] = [];
    for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex += 1) {
      const candidate = rows[nextIndex];
      if (parsePriceOnly(candidate.text) !== null) break;
      if (row.y - candidate.y > 45) break;
      const text = normalizeText(candidate.text);
      if (!isDailyMenuName(text)) continue;
      nameRows.push(text);
    }

    if (nameRows.length === 0) continue;
    const name = nameRows.join(" ");
    menuItems.push(sharedMenuItem(name, price, rule));
  }

  return menuItems;
}

function isRowInYRanges(row: ColumnRow, ranges: readonly YRange[]): boolean {
  return ranges.some((range) => row.y >= range.min && row.y <= range.max);
}

function parseSharedPriceItems(items: readonly PdfTextItem[], rule: SharedRowProfile): MenuItem[] {
  const menuItems: MenuItem[] = [];

  for (const rowTokens of groupSharedRowTokens(items)) {
    const tokens = rowTokens.filter((token) => token !== rule.label && !/^[~～]$/.test(token));
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];

      const priceMarkerIndex = token.search(/[¥\\]/);
      if (priceMarkerIndex < 0) continue;

      const name = cleanSharedItemName(token.slice(0, priceMarkerIndex), rule);
      let priceText = token.slice(priceMarkerIndex + 1).replace(/\D/g, "");
      while (index + 1 < tokens.length && isDigitToken(tokens[index + 1])) {
        index += 1;
        priceText += tokens[index].replace(/\D/g, "");
      }

      if (!name || !priceText) continue;
      menuItems.push(sharedMenuItem(name, Number(priceText), rule));
    }
  }

  return uniqueMenuItems(menuItems);
}

function groupSharedRowTokens(items: readonly PdfTextItem[]): string[][] {
  const rows: Array<{ y: number; texts: Array<{ x: number; text: string }> }> = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const text = normalizeText(item.text);
    if (!text) continue;
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
    if (row) {
      row.texts.push({ x: item.x, text });
      row.y = (row.y + item.y) / 2;
    } else {
      rows.push({ y: item.y, texts: [{ x: item.x, text }] });
    }
  }

  return rows.map((row) => row.texts.sort((a, b) => a.x - b.x).map((item) => item.text));
}

function cleanSharedItemName(name: string, rule: SharedRowProfile): string {
  const normalized = normalizeText(name).replace(/\s+/g, "");
  if (normalized === rule.label) return "";
  if (normalized && normalized.length < rule.label.length && rule.label.endsWith(normalized)) return rule.label;
  return normalized;
}

function profileRowsNotDetectedWarning(slug: string): string {
  return `profile_rows_not_detected:${slug}`;
}

function pushUniqueWarnings(target: string[], warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (!target.includes(warning)) target.push(warning);
  }
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return Array.from(new Set(warnings));
}

function isDigitToken(text: string): boolean {
  return /^\d+$/.test(normalizeText(text));
}

function parsePriceOnly(text: string): number | null {
  const match = normalizeText(text).match(/^¥\s*(\d{2,5})$/);
  return match ? Number(match[1]) : null;
}

function isDailyMenuName(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    !!normalized &&
    !/^ラーメン販売$/.test(normalized) &&
    !/^ありません$/.test(normalized) &&
    !/^大盛販売ありません$/.test(normalized)
  );
}

function sharedMenuItem(
  name: string,
  priceYen: number,
  rule: Pick<SharedRowProfile, "category" | "categoryLabel">
): MenuItem {
  return {
    name,
    nameLines: [name],
    category: rule.category,
    categoryLabel: rule.categoryLabel,
    priceYen,
    priceText: `¥${priceYen}`,
    confidence: 0.9,
    warnings: []
  };
}

function uniqueMenuItems(items: readonly MenuItem[]): MenuItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.category}:${item.name}:${item.priceYen ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
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

function statusForRawText(
  rawText: string | null,
  profile: LocationParserProfile = DEFAULT_LOCATION_PROFILE,
  hasStrongDailyMenuEvidence = false
): LocationStatus {
  if (!rawText) return "not_published";
  const statusLines = rawText.split("\n").filter((line) => !isWeekdayClosedNotice(line));
  const meaningfulLines = statusLines.filter((line) => !isMetaLineForStatus(line, profile.structure));
  if (meaningfulLines.length === 0 && profile.metaOnlyStatus) return profile.metaOnlyStatus;
  if (hasStrongDailyMenuEvidence) return "ok";
  if (containsClosedNotice(statusLines.join("\n"))) return "closed";
  return "ok";
}

function containsClosedNotice(rawText: string | null): boolean {
  return !!rawText && /(休業|休み|閉店|定休日|closed)/i.test(rawText);
}

function isStrongDailyMenuEvidence(item: MenuItem): boolean {
  return item.category !== "unknown" && item.confidence === 0.9 && !containsClosedNotice(item.name);
}

function inferMenuTableBottomY(labelRows: readonly ColumnRow[], profile: StructureProfile): number | undefined {
  const categoryLabels = labelRows.filter((row) => {
    const label = normalizeText(row.text)
      .replace(/(?:¥|\\)\s*\d{2,5}/g, "")
      .replace(/^<(.+)>$/, "$1")
      .trim();
    return profile.categoryByLabel.some((rule) => rule.pattern.test(label));
  });
  if (categoryLabels.length === 0) return undefined;
  return Math.min(...categoryLabels.map((row) => row.y)) - profile.labelMaxNameDepth;
}

function isMetaLineForStatus(text: string, profile: StructureProfile): boolean {
  const normalized = normalizeText(text);
  return profile.metaLinePatterns.some((pattern) => pattern.test(normalized));
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
