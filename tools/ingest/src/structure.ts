import type { MenuCategory, MenuItem, MenuItemWarning } from "@cit-cafeteria/schema";

export interface ColumnRow {
  y: number;
  texts: string[];
  text: string;
}

export interface StructuredMenuRows {
  menuItems: MenuItem[];
  unassignedLines: string[];
}

interface WorkingRow extends ColumnRow {
  index: number;
}

interface LabelAnchor {
  y: number;
  priceRowY: number | null;
  label: string;
  category: MenuCategory;
  priceYen: number | null;
  priceText: string | null;
  warnings: MenuItemWarning[];
}

const MARKER_NAME_MAX_GAP = 25;
const LABEL_PRICE_MAX_GAP = 25;
const LABEL_MAX_NAME_ABOVE = 25;
const LABEL_MAX_NAME_DEPTH = 52;
const LABEL_BAND_TOLERANCE = 3;
const PRICE_BLOCK_MAX_GAP = 45;
const NO_PRICE_BLOCK_GAP = 50;

const KOUDAI_MARKER_PATTERN = /^<工大(\d+)>$/;
const PRICE_ONLY_PATTERN = /^¥\s*\d+$/;
const PRICE_PATTERN = /(?:¥|\\)\s*(\d{2,5})/;
const RAMEN_CONTEXT_NAMES = new Set(["味噌", "塩", "醤油", "とんこつ"]);

const CATEGORY_BY_LABEL: Array<{ pattern: RegExp; category: MenuCategory; label: string }> = [
  { pattern: /^朝定食$/, category: "asa_teishoku", label: "朝定食" },
  { pattern: /^夕定食$/, category: "yu_teishoku", label: "夕定食" },
  { pattern: /^日替りサラダ$/, category: "higawari_salad", label: "日替りサラダ" },
  { pattern: /^グルメカレー$/, category: "gourmet_curry", label: "グルメカレー" },
  { pattern: /^日替りラーメン$/, category: "men_corner", label: "日替りラーメン" },
  { pattern: /^ラーメン$/, category: "men_corner", label: "ラーメン" },
  { pattern: /^チャーシュー麺$/, category: "men_corner", label: "チャーシュー麺" },
  { pattern: /^今日のパスタ$/, category: "keishoku_pasta", label: "今日のパスタ" },
  { pattern: /^今週のパスタ$/, category: "keishoku_pasta", label: "今週のパスタ" }
];

export function structureMenuRows(
  rows: readonly ColumnRow[],
  labelRows: readonly ColumnRow[] = []
): StructuredMenuRows {
  const workingRows = rows.map((row, index) => ({
    ...row,
    index,
    text: normalizeText(row.text),
    texts: row.texts.map(normalizeText).filter(Boolean)
  }));
  const used = new Set<number>();
  const menuItems: MenuItem[] = [];

  menuItems.push(...structureKoudaiMarkerItems(workingRows, used));

  const anchors = buildLabelAnchors(labelRows);
  if (anchors.length > 0) {
    menuItems.push(...structureLabelBandItems(workingRows, anchors, used));
  }

  menuItems.push(...structurePriceFallbackItems(workingRows, used));
  menuItems.push(...structureNoPriceFallbackItems(workingRows, used));

  return {
    menuItems,
    unassignedLines: workingRows
      .filter((row) => !used.has(row.index))
      .filter((row) => !isDiscardedLine(row.text))
      .map((row) => row.text)
  };
}

function structureKoudaiMarkerItems(rows: readonly WorkingRow[], used: Set<number>): MenuItem[] {
  const menuItems: MenuItem[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (used.has(row.index)) continue;
    const marker = row.text.match(KOUDAI_MARKER_PATTERN);
    if (!marker) continue;

    const nameRows: WorkingRow[] = [];
    let previousY = row.y;
    for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex += 1) {
      const candidate = rows[nextIndex];
      if (candidate.text.match(KOUDAI_MARKER_PATTERN)) break;
      if (previousY - candidate.y > MARKER_NAME_MAX_GAP) break;
      previousY = candidate.y;

      if (isDiscardedLine(candidate.text)) {
        used.add(candidate.index);
        continue;
      }
      if (!isNameCandidate(candidate.text)) break;
      nameRows.push(candidate);
    }

    const nameLines = nameRows.map((nameRow) => nameRow.text);
    if (nameLines.length === 0) continue;

    used.add(row.index);
    for (const nameRow of nameRows) used.add(nameRow.index);
    menuItems.push(
      menuItem({
        nameLines,
        category: "koudai_teishoku",
        categoryLabel: "工大定食",
        priceYen: Number(marker[1]),
        priceText: row.text,
        confidence: 0.9,
        warnings: []
      })
    );
  }

  return menuItems;
}

function structureLabelBandItems(
  rows: readonly WorkingRow[],
  anchors: readonly LabelAnchor[],
  used: Set<number>
): MenuItem[] {
  const menuItems: MenuItem[] = [];

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const previousAnchor = index === 0 ? null : anchors[index - 1];
    const nextAnchor = index === anchors.length - 1 ? null : anchors[index + 1];
    const upper = previousAnchor
      ? midpoint(previousAnchor.priceRowY ?? previousAnchor.y, anchor.y)
      : Number.POSITIVE_INFINITY;
    const lower = nextAnchor ? midpoint(anchor.priceRowY ?? anchor.y, nextAnchor.y) : Number.NEGATIVE_INFINITY;

    const nameRows = rows.filter(
      (row) => !used.has(row.index) && isNameCandidate(row.text) && isInsideLabelBand(row, anchor, upper, lower)
    );

    if (nameRows.length === 0) continue;

    const cellPriceRow = rows.find(
      (row) => !used.has(row.index) && isPriceOnlyLine(row.text) && isInsideLabelBand(row, anchor, upper, lower)
    );
    const cellPrice = cellPriceRow ? parsePrice(cellPriceRow.text) : null;

    for (const row of nameRows) used.add(row.index);
    if (cellPriceRow) used.add(cellPriceRow.index);
    menuItems.push(
      menuItem({
        nameLines: nameRows.map((row) => row.text),
        category: anchor.category,
        categoryLabel: anchor.label,
        priceYen: cellPrice?.priceYen ?? anchor.priceYen,
        priceText: cellPrice?.priceText ?? anchor.priceText,
        confidence: 0.9,
        warnings: anchor.warnings
      })
    );
  }

  return menuItems;
}

function isInsideLabelBand(row: WorkingRow, anchor: LabelAnchor, upper: number, lower: number): boolean {
  if (row.y > upper + LABEL_BAND_TOLERANCE || row.y <= lower - LABEL_BAND_TOLERANCE) return false;
  if (row.y > anchor.y + LABEL_MAX_NAME_ABOVE) return false;
  if (row.y < anchor.y - LABEL_MAX_NAME_DEPTH) return false;
  return true;
}

function structurePriceFallbackItems(rows: readonly WorkingRow[], used: Set<number>): MenuItem[] {
  const menuItems: MenuItem[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const priceRow = rows[index];
    if (used.has(priceRow.index) || !isPriceOnlyLine(priceRow.text)) continue;

    const upperNameRows = collectAdjacentNameRows(rows, used, index, -1);
    const lowerNameRows = collectAdjacentNameRows(rows, used, index, 1);
    const nameRows = sortTopToBottom(uniqueRows(upperNameRows.length > 0 ? upperNameRows : lowerNameRows));
    if (nameRows.length === 0) continue;

    used.add(priceRow.index);
    for (const row of nameRows) used.add(row.index);
    menuItems.push(
      menuItem({
        nameLines: nameRows.map((row) => row.text),
        category: "unknown",
        categoryLabel: null,
        priceYen: parsePrice(priceRow.text)?.priceYen ?? null,
        priceText: priceRow.text,
        confidence: 0.6,
        warnings: ["category_unknown"]
      })
    );
  }

  return menuItems;
}

function structureNoPriceFallbackItems(rows: readonly WorkingRow[], used: Set<number>): MenuItem[] {
  const menuItems: MenuItem[] = [];
  let current: WorkingRow[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const nameRows = current.filter((row) => isNameCandidate(row.text));
    current = [];
    if (nameRows.length === 0 || !hasMeaningfulName(nameRows)) return;

    for (const row of nameRows) used.add(row.index);
    menuItems.push(
      menuItem({
        nameLines: nameRows.map((row) => row.text),
        category: "unknown",
        categoryLabel: null,
        priceYen: null,
        priceText: null,
        confidence: 0.6,
        warnings: ["price_not_found", "category_unknown"]
      })
    );
  };

  for (const row of rows) {
    if (used.has(row.index) || isDiscardedLine(row.text) || !isNameCandidate(row.text)) {
      flush();
      continue;
    }

    const previous = current.at(-1);
    if (previous && previous.y - row.y >= NO_PRICE_BLOCK_GAP) flush();
    current.push(row);
  }
  flush();

  return menuItems;
}

function collectAdjacentNameRows(
  rows: readonly WorkingRow[],
  used: ReadonlySet<number>,
  priceIndex: number,
  direction: -1 | 1
): WorkingRow[] {
  const collected: WorkingRow[] = [];
  let previousY = rows[priceIndex].y;

  for (let index = priceIndex + direction; index >= 0 && index < rows.length; index += direction) {
    const row = rows[index];
    const gap = direction === -1 ? row.y - previousY : previousY - row.y;
    if (gap > PRICE_BLOCK_MAX_GAP) break;
    previousY = row.y;

    if (used.has(row.index) || isPriceOnlyLine(row.text) || row.text.match(KOUDAI_MARKER_PATTERN)) break;
    if (isDiscardedLine(row.text) || isMetaLine(row.text)) continue;
    if (!isNameCandidate(row.text)) break;
    collected.push(row);
  }

  return collected;
}

function buildLabelAnchors(labelRows: readonly ColumnRow[]): LabelAnchor[] {
  const rows = labelRows
    .map((row) => ({
      ...row,
      text: normalizeText(row.text),
      texts: row.texts.map(normalizeText).filter(Boolean)
    }))
    .filter((row) => row.text)
    .sort((a, b) => b.y - a.y);

  const anchors: LabelAnchor[] = [];
  for (const row of rows) {
    if (isDiscardedLine(row.text) || isMetaLine(row.text) || isPriceOnlyLine(row.text) || isSectionHeader(row.text)) {
      continue;
    }

    const label = cleanLabel(row.text);
    const category = categoryForLabel(label);
    const inlinePrice = parsePrice(row.text);
    const nearbyPrice = inlinePrice ?? findNearbyPrice(row, rows);
    if (!category && !nearbyPrice) continue;

    const warnings: MenuItemWarning[] = [];
    if (!nearbyPrice) warnings.push("price_not_found");
    if (!category) warnings.push("category_unknown");

    anchors.push({
      y: row.y,
      priceRowY: nearbyPrice?.rowY ?? null,
      label: category?.label ?? label,
      category: category?.category ?? "unknown",
      priceYen: nearbyPrice?.priceYen ?? null,
      priceText: nearbyPrice?.priceText ?? null,
      warnings
    });
  }

  return anchors;
}

function findNearbyPrice(row: ColumnRow, rows: readonly ColumnRow[]) {
  const priceRow = rows.find(
    (candidate) => candidate.y < row.y && row.y - candidate.y <= LABEL_PRICE_MAX_GAP && isPriceOnlyLine(candidate.text)
  );
  if (!priceRow) return null;
  const price = parsePrice(priceRow.text);
  if (!price) return null;
  return { ...price, rowY: priceRow.y };
}

function parsePrice(text: string): { priceYen: number; priceText: string; rowY?: number } | null {
  const match = normalizeText(text).match(PRICE_PATTERN);
  if (!match) return null;
  return {
    priceYen: Number(match[1]),
    priceText: normalizeText(text)
  };
}

function categoryForLabel(label: string): { category: MenuCategory; label: string } | null {
  return CATEGORY_BY_LABEL.find((item) => item.pattern.test(label)) ?? null;
}

function cleanLabel(text: string): string {
  return normalizeText(text)
    .replace(PRICE_PATTERN, "")
    .replace(/^<(.+)>$/, "$1")
    .trim();
}

function menuItem(input: {
  nameLines: string[];
  category: MenuCategory;
  categoryLabel: string | null;
  priceYen: number | null;
  priceText: string | null;
  confidence: MenuItem["confidence"];
  warnings: MenuItemWarning[];
}): MenuItem {
  const nameLines = input.nameLines.map(normalizeText).filter(Boolean);
  const warnings = [...input.warnings];
  if (
    input.category === "men_corner" &&
    input.categoryLabel === "ラーメン" &&
    nameLines.length === 1 &&
    RAMEN_CONTEXT_NAMES.has(nameLines[0]) &&
    !warnings.includes("name_may_be_incomplete")
  ) {
    warnings.push("name_may_be_incomplete");
  }

  return {
    name: nameLines.join(" "),
    nameLines,
    category: input.category,
    categoryLabel: input.categoryLabel,
    priceYen: input.priceYen,
    priceText: input.priceText,
    confidence: input.confidence,
    warnings
  };
}

function isPriceOnlyLine(text: string): boolean {
  return PRICE_ONLY_PATTERN.test(normalizeText(text));
}

function isSectionHeader(text: string): boolean {
  return /^<.+コーナー>$/.test(normalizeText(text));
}

function isNameCandidate(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    !!normalized &&
    !isDiscardedLine(normalized) &&
    !isMetaLine(normalized) &&
    !isPriceOnlyLine(normalized) &&
    !normalized.match(KOUDAI_MARKER_PATTERN)
  );
}

function isDiscardedLine(text: string): boolean {
  return /^ご飯[・･]みそ汁付$/.test(normalizeText(text));
}

function isMetaLine(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /(?:https?:\/\/|CIT学食|シー・アイ・ティ・サービス|都合により|検索できます|学食券|変則的|営業時間|大盛販売ありません)/.test(
      normalized
    ) ||
    /^<営業時間>$/.test(normalized) ||
    /^(?:昼・夕定食|朝定食\s+\d|麺・軽食|土曜日|\*土曜日\*)/.test(normalized) ||
    /^[\d\s:：~～()（）]+$/.test(normalized)
  );
}

function hasMeaningfulName(rows: readonly WorkingRow[]): boolean {
  return rows.some((row) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]/u.test(row.text));
}

function uniqueRows(rows: readonly WorkingRow[]): WorkingRow[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.index)) return false;
    seen.add(row.index);
    return true;
  });
}

function sortTopToBottom(rows: readonly WorkingRow[]): WorkingRow[] {
  return [...rows].sort((a, b) => b.y - a.y || a.index - b.index);
}

function midpoint(left: number, right: number): number {
  return left + (right - left) / 2;
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}
