import { describe, expect, it } from "vitest";
import { appliesToDate, findClosureNotices, isClosurePredicate, mergeClosureNotices, type NoticeRow } from "./notices";

const context = {
  date: "2026-07-17",
  insideTable: (row: NoticeRow) => row.y > 300,
  isBarrier: (row: NoticeRow) => row.text.startsWith("¥")
};

describe("closure notices", () => {
  it("groups the real two-line boxed-lunch notice with audit provenance", () => {
    const notices = findClosureNotices(
      [row("お弁当販売は、食中毒予防のため", 212.42, 10, 200, 142), row("夏季期間中 休業します", 178.42, 20, 190, 143)],
      context
    );

    expect(notices).toEqual([
      expect.objectContaining({
        subject: "separate_service",
        appliesTo: { kind: "document" },
        matchedRule: "closure.separate_service.bento_sales",
        sourceItemIndexes: [142, 143],
        bounds: { left: 10, bottom: 178.42, right: 200, top: 222.42 }
      })
    ]);
  });

  it("does not attach distant, low-overlap, or barrier rows", () => {
    const notices = findClosureNotices(
      [row("お弁当販売", 250, 0, 20, 1), row("休業します", 180, 100, 200, 2), row("¥300", 175, 100, 200, 3)],
      context
    );

    expect(notices[0].subject).toBe("unknown");
    expect(notices[0].sourceItemIndexes).toEqual([2]);
  });

  it("classifies cafeteria, weekday, date, and unknown applicability", () => {
    const temporary = findClosureNotices([row("臨時休業", 500, 100, 180, 1)], context)[0];
    expect(temporary).toMatchObject({
      subject: "cafeteria",
      appliesTo: { kind: "dates", dates: ["2026-07-17"] }
    });

    const weekday = findClosureNotices([row("土曜日休業", 200, 100, 180, 2)], context)[0];
    expect(weekday).toMatchObject({ subject: "cafeteria", appliesTo: { kind: "weekdays", weekdays: [6] } });
    expect(appliesToDate(weekday, "2026-07-18")).toBe(true);

    const dated = findClosureNotices([row("7月18日は休業します", 200, 100, 180, 3)], context)[0];
    expect(dated).toMatchObject({ subject: "unknown", appliesTo: { kind: "dates", dates: ["2026-07-18"] } });
  });

  it("accepts simple closure wording without enumerating suffixes", () => {
    expect(isClosurePredicate("休業中")).toBe(true);
    expect(isClosurePredicate("明日は休み")).toBe(true);
  });

  it("infers notice years nearest to the menu context", () => {
    const january = findClosureNotices([row("1月5日は休業", 200, 100, 180, 4)], {
      ...context,
      date: "2026-12-28"
    })[0];
    expect(january.appliesTo).toEqual({ kind: "dates", dates: ["2027-01-05"] });

    const december = findClosureNotices([row("12月28日は休業", 200, 100, 180, 5)], {
      ...context,
      date: "2027-01-04"
    })[0];
    expect(december.appliesTo).toEqual({ kind: "dates", dates: ["2026-12-28"] });
  });

  it("merges dates inferred from the same physical notice evidence", () => {
    const tuesday = findClosureNotices([row("臨時休業", 500, 100, 180, 6)], {
      ...context,
      date: "2026-07-14"
    })[0];
    const friday = findClosureNotices([row("臨時休業", 500, 100, 180, 6)], {
      ...context,
      date: "2026-07-17"
    })[0];

    expect(mergeClosureNotices([tuesday, friday])).toEqual({
      notices: [expect.objectContaining({ appliesTo: { kind: "dates", dates: ["2026-07-14", "2026-07-17"] } })],
      warnings: []
    });
  });
});

function row(text: string, y: number, left: number, right: number, index: number): NoticeRow {
  return {
    text,
    y,
    page: 1,
    bounds: { left, bottom: y, right, top: y + 10 },
    sourceItemIndexes: [index]
  };
}
