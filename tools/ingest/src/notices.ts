import { inferDateFromMonthDay } from "./dates";

export interface NoticeBounds {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export interface NoticeRow {
  text: string;
  y: number;
  page: number;
  bounds: NoticeBounds;
  sourceItemIndexes: number[];
}

export type NoticeApplicability =
  | { kind: "document" }
  | { kind: "weekdays"; weekdays: number[] }
  | { kind: "dates"; dates: string[] };

export interface ClosureNotice {
  subject: "cafeteria" | "separate_service" | "unknown";
  appliesTo: NoticeApplicability;
  lines: string[];
  page: number;
  bounds: NoticeBounds;
  matchedRule: string;
  sourceItemIndexes: number[];
}

export interface ClosureNoticeMergeResult {
  notices: ClosureNotice[];
  warnings: string[];
}

export interface NoticeContext {
  date: string;
  insideTable: (row: NoticeRow) => boolean;
  isBarrier: (row: NoticeRow) => boolean;
}

const MAX_NOTICE_ROW_GAP = 45;
const MIN_HORIZONTAL_OVERLAP = 0.5;
const WEEKDAY_INDEX = new Map([
  ["日", 0],
  ["月", 1],
  ["火", 2],
  ["水", 3],
  ["木", 4],
  ["金", 5],
  ["土", 6]
]);

export function findClosureNotices(rows: readonly NoticeRow[], context: NoticeContext): ClosureNotice[] {
  const ordered = [...rows].sort((a, b) => b.y - a.y);
  const notices: ClosureNotice[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const predicateRow = ordered[index];
    if (!closurePredicate(predicateRow.text)) continue;

    const block = [predicateRow];
    for (const direction of [-1, 1] as const) {
      const neighbor = ordered[index + direction];
      if (!neighbor || neighbor.page !== predicateRow.page) continue;
      if (Math.abs(neighbor.y - predicateRow.y) > MAX_NOTICE_ROW_GAP) continue;
      if (context.isBarrier(neighbor) || !isNoticeContextLine(neighbor.text)) continue;
      if (horizontalOverlapRatio(predicateRow.bounds, neighbor.bounds) < MIN_HORIZONTAL_OVERLAP) continue;
      block.push(neighbor);
    }

    notices.push(classifyClosureNotice(block, predicateRow, context));
  }

  return uniqueNotices(notices);
}

export function appliesToDate(notice: ClosureNotice, date: string): boolean {
  if (notice.appliesTo.kind === "document") return true;
  if (notice.appliesTo.kind === "dates") return notice.appliesTo.dates.includes(date);
  return notice.appliesTo.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
}

export function isClosurePredicate(text: string): boolean {
  return closurePredicate(text);
}

export function mergeClosureNotices(notices: readonly ClosureNotice[]): ClosureNoticeMergeResult {
  const merged = new Map<string, ClosureNotice>();
  const warnings: string[] = [];

  for (const notice of notices) {
    const key = notice.sourceItemIndexes.join(",");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, cloneNotice(notice));
      continue;
    }

    if (!sameNoticeEvidence(existing, notice)) {
      pushUnique(warnings, "closure_notice_evidence_conflict");
      continue;
    }

    const appliesTo = mergeApplicability(existing.appliesTo, notice.appliesTo);
    if (!appliesTo) {
      pushUnique(warnings, "closure_notice_applicability_conflict");
      continue;
    }
    existing.appliesTo = appliesTo;
  }

  return { notices: Array.from(merged.values()), warnings };
}

function classifyClosureNotice(
  rows: readonly NoticeRow[],
  predicateRow: NoticeRow,
  context: NoticeContext
): ClosureNotice {
  const sorted = [...rows].sort((a, b) => b.y - a.y);
  const lines = sorted.map((row) => normalizeText(row.text));
  const text = lines.join(" ");
  const weekday = weekdayFromText(text);
  const dates = datesFromText(text, context.date);

  let subject: ClosureNotice["subject"];
  let matchedRule: string;
  if (/(?:お弁当|弁当)販売/.test(text)) {
    subject = "separate_service";
    matchedRule = "closure.separate_service.bento_sales";
  } else if (/(?:全食堂|食堂|学食)/.test(text)) {
    subject = "cafeteria";
    matchedRule = "closure.cafeteria.explicit_subject";
  } else if (/^臨時休業$/.test(normalizeText(predicateRow.text))) {
    subject = "cafeteria";
    matchedRule = "closure.cafeteria.temporary";
  } else if (weekday !== null && /^[日月火水木金土]曜日休業$/.test(normalizeText(predicateRow.text))) {
    subject = "cafeteria";
    matchedRule = "closure.cafeteria.weekday_schedule";
  } else {
    subject = "unknown";
    matchedRule = "closure.subject.unknown";
  }

  const appliesTo: NoticeApplicability =
    dates.length > 0
      ? { kind: "dates", dates }
      : weekday !== null
        ? { kind: "weekdays", weekdays: [weekday] }
        : context.insideTable(predicateRow)
          ? { kind: "dates", dates: [context.date] }
          : { kind: "document" };

  return {
    subject,
    appliesTo,
    lines,
    page: predicateRow.page,
    bounds: unionBounds(sorted.map((row) => row.bounds)),
    matchedRule,
    sourceItemIndexes: Array.from(new Set(sorted.flatMap((row) => row.sourceItemIndexes))).sort((a, b) => a - b)
  };
}

function closurePredicate(text: string): boolean {
  const normalized = normalizeText(text);
  return /休業|休み|定休日|閉店|\bclosed\b/i.test(normalized);
}

function isNoticeContextLine(text: string): boolean {
  const normalized = normalizeText(text);
  return /(?:弁当販売|お弁当|食堂|学食|夏季|冬季|期間|食中毒|予防|都合|ため|曜日|\d{1,2}月\d{1,2}日)/.test(normalized);
}

function weekdayFromText(text: string): number | null {
  const match = normalizeText(text).match(/([日月火水木金土])曜日休業/);
  return match ? (WEEKDAY_INDEX.get(match[1]) ?? null) : null;
}

function datesFromText(text: string, contextDate: string): string[] {
  const dates: string[] = [];
  for (const match of normalizeText(text).matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    try {
      dates.push(inferDateFromMonthDay(month, day, contextDate));
    } catch {
      // Invalid calendar dates are not notice evidence.
    }
  }
  return Array.from(new Set(dates));
}

function horizontalOverlapRatio(left: NoticeBounds, right: NoticeBounds): number {
  const overlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const narrower = Math.min(left.right - left.left, right.right - right.left);
  return narrower > 0 ? overlap / narrower : 0;
}

function unionBounds(bounds: readonly NoticeBounds[]): NoticeBounds {
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    bottom: Math.min(...bounds.map((item) => item.bottom)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.max(...bounds.map((item) => item.top))
  };
}

function uniqueNotices(notices: readonly ClosureNotice[]): ClosureNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = notice.sourceItemIndexes.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneNotice(notice: ClosureNotice): ClosureNotice {
  return {
    ...notice,
    appliesTo:
      notice.appliesTo.kind === "document"
        ? { kind: "document" }
        : notice.appliesTo.kind === "dates"
          ? { kind: "dates", dates: [...notice.appliesTo.dates] }
          : { kind: "weekdays", weekdays: [...notice.appliesTo.weekdays] },
    lines: [...notice.lines],
    bounds: { ...notice.bounds },
    sourceItemIndexes: [...notice.sourceItemIndexes]
  };
}

function sameNoticeEvidence(left: ClosureNotice, right: ClosureNotice): boolean {
  return (
    left.page === right.page &&
    left.subject === right.subject &&
    left.matchedRule === right.matchedRule &&
    left.lines.join("\n") === right.lines.join("\n")
  );
}

function mergeApplicability(left: NoticeApplicability, right: NoticeApplicability): NoticeApplicability | null {
  if (left.kind !== right.kind) return null;
  if (left.kind === "document" && right.kind === "document") return { kind: "document" };
  if (left.kind === "dates" && right.kind === "dates") {
    return { kind: "dates", dates: Array.from(new Set([...left.dates, ...right.dates])).sort() };
  }
  if (left.kind === "weekdays" && right.kind === "weekdays") {
    return { kind: "weekdays", weekdays: Array.from(new Set([...left.weekdays, ...right.weekdays])).sort() };
  }
  return null;
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}
