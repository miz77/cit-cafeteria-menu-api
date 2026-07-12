import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { __test__, fallbackLocationMenu, parseLocationPdf } from "./parser";
import { DEFAULT_PDF_LIMITS, type FetchedPdf, type PdfExtraction } from "./pdf";
import type { IngestSource } from "./sources";

function loadFixture(name: string): PdfExtraction {
  return JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as PdfExtraction;
}

function sourceFor(locationId: IngestSource["locationId"]): IngestSource {
  const basename = locationId === "tsudanuma" ? "t.pdf" : locationId === "shinnarashino-1f" ? "s1.pdf" : "s2.pdf";
  return {
    locationId,
    sourcePageUrl: "https://www.cit-s.com/dining/",
    pdfUrl: `https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/${basename}`,
    discovered: true,
    warnings: []
  };
}

function fetchedPdf(locationId: IngestSource["locationId"] = "tsudanuma"): FetchedPdf {
  return {
    source: sourceFor(locationId),
    bytes: new Uint8Array([1, 2, 3]),
    fetchedAt: "2026-07-03T00:00:00.000Z",
    sha256: "a".repeat(64),
    warnings: []
  };
}

function parserCharacterizationSnapshot(result: ReturnType<typeof parseLocationPdf>) {
  return Array.from(result.menusByDate.entries()).map(([date, menu]) => ({
    date,
    status: menu.status,
    menuText: {
      lines: menu.menuText.lines
    },
    menuItems: menu.menuItems,
    unassignedLines: menu.unassignedLines,
    parser: {
      warnings: menu.parser.warnings
    }
  }));
}

const tsudanumaCharacterizationFixtures = [
  {
    name: "tsudanuma-single-block",
    fixture: "tsudanuma-single-block.json",
    referenceDate: "2026-07-03"
  },
  {
    name: "tsudanuma-two-block",
    fixture: "tsudanuma-two-block.json",
    referenceDate: "2026-07-03"
  }
] as const;

const shinnarashinoLegacyBehaviorFixtures = [
  {
    name: "shinnarashino-1f-single-block",
    locationId: "shinnarashino-1f",
    fixture: "shinnarashino-1f-single-block.json",
    referenceDate: "2026-07-03"
  },
  {
    name: "shinnarashino-2f-single-block",
    locationId: "shinnarashino-2f",
    fixture: "shinnarashino-2f-single-block.json",
    referenceDate: "2026-07-03"
  }
] as const satisfies ReadonlyArray<{
  name: string;
  locationId: IngestSource["locationId"];
  fixture: string;
  referenceDate: string;
}>;

const shinnarashinoIntendedOutputFixtures = [
  {
    name: "shinnarashino-1f-20260706",
    locationId: "shinnarashino-1f",
    fixture: "shinnarashino-1f-20260706.json",
    referenceDate: "2026-07-07"
  },
  {
    name: "shinnarashino-2f-20260706",
    locationId: "shinnarashino-2f",
    fixture: "shinnarashino-2f-20260706.json",
    referenceDate: "2026-07-07"
  }
] as const satisfies ReadonlyArray<{
  name: string;
  locationId: IngestSource["locationId"];
  fixture: string;
  referenceDate: string;
}>;

describe("simple PDF parser", () => {
  it("extracts raw text by date column", () => {
    const extraction: PdfExtraction = {
      pageCount: 1,
      warnings: [],
      items: [
        { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
        { text: "7月7日（火）", page: 1, x: 200, y: 700, width: 40, height: 10 },
        { text: "カレー", page: 1, x: 100, y: 650, width: 40, height: 10 },
        { text: "味噌汁", page: 1, x: 102, y: 630, width: 40, height: 10 },
        { text: "ラーメン", page: 1, x: 200, y: 650, width: 40, height: 10 }
      ]
    };

    const result = parseLocationPdf(fetchedPdf(), extraction, DEFAULT_PDF_LIMITS, "2026-07-03");

    expect(result.status).toBe("ok");
    expect(result.menusByDate.get("2026-07-06")?.menuText.lines).toEqual(["カレー", "味噌汁"]);
    expect(result.menusByDate.get("2026-07-07")?.menuText.lines).toEqual(["ラーメン"]);
  });

  it("marks multi-page PDFs as source_changed", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 2,
        warnings: [],
        items: []
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    expect(result.status).toBe("source_changed");
    expect(result.menusByDate.size).toBe(0);
  });

  it("supports omitted month after an explicit month", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [
          { text: "7月31日（金）", page: 1, x: 100, y: 700, width: 40, height: 10 },
          { text: "1日（土）", page: 1, x: 200, y: 700, width: 40, height: 10 },
          { text: "A定食", page: 1, x: 100, y: 650, width: 40, height: 10 },
          { text: "B定食", page: 1, x: 200, y: 650, width: 40, height: 10 }
        ]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-30"
    );

    expect(Array.from(result.menusByDate.keys())).toEqual(["2026-07-31", "2026-08-01"]);
  });

  it("detects day-with-weekday headers without duplicating slash or day headers", () => {
    expect(__test__.dateMatches("10(金)")).toEqual([{ day: 10 }]);
    expect(__test__.dateMatches("7/10(金)")).toEqual([{ month: 7, day: 10 }]);
    expect(__test__.dateMatches("3日(金)")).toEqual([{ day: 3 }]);
  });

  it("splits date headers into blocks on a wide x gap", () => {
    const header = (date: string, x: number) => ({
      date,
      x,
      y: 700,
      page: 1,
      item: { text: date, page: 1, x, y: 700, width: 40, height: 10 }
    });
    const headers = [header("2026-07-01", 100), header("2026-07-02", 200), header("2026-07-06", 500)];

    const { columns, blockCount } = __test__.computeHeaderColumns(headers);

    expect(blockCount).toBe(2);
    // Block-edge columns close at half the median gap (100 / 2 = 50).
    expect(columns.map(({ left, right }) => [left, right])).toEqual([
      [50, 150],
      [150, 250],
      [450, 550]
    ]);
  });

  it("keeps a regular one-week PDF as a single block and excludes the label gutter", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      loadFixture("tsudanuma-single-block.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    expect(result.status).toBe("ok");
    expect(Array.from(result.menusByDate.keys())).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04"
    ]);

    const monday = result.menusByDate.get("2026-06-29");
    expect(monday?.parser.warnings).not.toContain("multi_block_layout_detected");
    // Row labels from the left gutter must not leak into Monday's column.
    expect(monday?.menuText.rawText).toContain("ソースチキンカツ丼");
    expect(monday?.menuText.rawText).not.toContain("朝定食");
    expect(monday?.menuText.rawText).not.toContain("チャーシュー麺¥400");
    expect(monday?.menuText.rawText).not.toContain("グルメカレー");

    expect(monday?.menuItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ツナとアボカド",
          category: "higawari_salad",
          priceYen: 150
        }),
        expect.objectContaining({
          name: "温玉&粉チーズ",
          category: "gourmet_curry",
          priceYen: 350
        })
      ])
    );
  });

  it("handles a two-block PDF without leaking the inter-block label gutter into 7/4", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      loadFixture("tsudanuma-two-block.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    expect(result.status).toBe("ok");
    expect(result.menusByDate.size).toBe(12);
    expect(result.menusByDate.has("2026-06-29")).toBe(true);
    expect(result.menusByDate.has("2026-07-11")).toBe(true);

    const saturday = result.menusByDate.get("2026-07-04");
    expect(saturday?.parser.warnings).toContain("multi_block_layout_detected");
    // Real 7/4 content stays.
    expect(saturday?.menuText.rawText).toContain("豚の塩焼肉丼");
    // The second block's row-label gutter must not be picked up as 7/4 menu.
    expect(saturday?.menuText.rawText).not.toContain("朝定食");
    expect(saturday?.menuText.rawText).not.toContain("日替りラーメン");
    expect(saturday?.menuText.rawText).not.toContain("チャーシュー麺¥400");
    expect(saturday?.menuText.rawText).not.toContain("¥300");
    expect(saturday?.menuItems).toEqual([
      expect.objectContaining({
        name: "唐揚 甘酢ソース",
        category: "koudai_teishoku",
        priceYen: 350
      }),
      expect.objectContaining({
        name: "豚の塩焼肉丼",
        category: "koudai_teishoku",
        priceYen: 300
      })
    ]);
    expect(saturday?.menuItems.some((item) => item.category === "asa_teishoku")).toBe(false);

    // First date of the second block must not swallow the gutter either.
    const nextMonday = result.menusByDate.get("2026-07-06");
    expect(nextMonday?.menuText.rawText).toContain("ピリ辛そぼろ丼");
    expect(nextMonday?.menuText.rawText).not.toContain("チャーシュー麺¥400");
    expect(nextMonday?.menuText.rawText).not.toContain("日替りラーメン");

    const friday = result.menusByDate.get("2026-07-10");
    expect(friday?.menuItems.map((item) => item.name).join("\n")).not.toContain("学食券");
    expect(friday?.unassignedLines).toEqual(
      expect.arrayContaining(["学食券の対応の為", "変則的なメニュー提供になります"])
    );

    const wednesday = result.menusByDate.get("2026-07-08");
    expect(wednesday?.menuItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ヒレカツ",
          category: "yu_teishoku",
          priceYen: 350,
          priceText: "¥350"
        }),
        expect.objectContaining({
          name: "味噌",
          category: "men_corner",
          categoryLabel: "ラーメン",
          warnings: expect.arrayContaining(["name_may_be_incomplete"])
        })
      ])
    );
    expect(wednesday?.unassignedLines).not.toContain("¥350");
  });

  it("keeps a day open when a footer says that a different service is closed", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      loadFixture("tsudanuma-20260713.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-13"
    );

    const friday = result.menusByDate.get("2026-07-17");
    expect(friday?.status).toBe("ok");
    expect(friday?.menuText.rawText).toContain("夏季期間中 休業します");
    expect(friday?.menuItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "四川風焼肉丼 水ギョーザ", priceYen: 400 }),
        expect.objectContaining({ name: "唐揚 ピリ辛ソース", priceYen: 350 }),
        expect.objectContaining({ name: "ビビンバ丼", category: "yu_teishoku", priceYen: 300 })
      ])
    );
    expect(friday?.parser.warnings).not.toContain("closed_notice_conflicts_with_daily_menu");
    expect(result.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "separate_service",
          matchedRule: "closure.separate_service.bento_sales",
          sourceItemIndexes: expect.any(Array)
        })
      ])
    );
  });

  it("expands merged menu cells from physical rulings without forward-filling text", () => {
    const dates = ["13", "14", "15", "16", "17", "18"];
    const items: PdfExtraction["items"] = [
      ...dates.map((day, index) => ({
        text: `${index === 0 ? "7月" : ""}${day}日（${"月火水木金土"[index]}）`,
        page: 1,
        x: 130 + index * 100,
        y: 700,
        width: 40,
        height: 10
      })),
      { text: "今週のパスタ", page: 1, x: 20, y: 120, width: 70, height: 10 },
      { text: "チキンクリーム", page: 1, x: 110, y: 110, width: 80, height: 20 },
      { text: "チキントマトソース", page: 1, x: 330, y: 110, width: 140, height: 20 },
      { text: "今日のパスタ", page: 1, x: 20, y: 80, width: 70, height: 10 },
      ...dates.map((day, index) => ({
        text: `日替り${day}`,
        page: 1,
        x: 120 + index * 100,
        y: 70,
        width: 60,
        height: 20
      }))
    ];
    const vertical = (position: number, start: number, end: number, source: "stroke" | "thin_fill") => ({
      orientation: "vertical" as const,
      position,
      start,
      end,
      source
    });
    const horizontal = (position: number) => ({
      orientation: "horizontal" as const,
      position,
      start: 0,
      end: 700,
      source: "stroke" as const
    });
    const rulings: NonNullable<PdfExtraction["pageGeometry"]>[number]["rulings"] = [
      horizontal(60),
      horizontal(100),
      horizontal(140)
    ];
    for (const position of [100, 200, 600, 700]) rulings.push(vertical(position, 40, 160, "stroke"));
    for (const position of [300, 400, 500]) {
      rulings.push(vertical(position, 40, 100, "stroke"));
      rulings.push(vertical(position + 0.4, 40, 99.8, "thin_fill"));
      rulings.push(vertical(position, 140, 160, "stroke"));
    }

    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items,
        pageGeometry: [{ page: 1, view: { left: 0, bottom: 0, right: 700, top: 800 }, rulings }]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-13"
    );

    const weeklyNames = dates.map((day) =>
      result.menusByDate
        .get(`2026-07-${day}`)
        ?.menuItems.filter((item) => item.categoryLabel === "今週のパスタ")
        .map((item) => item.name)
    );
    expect(weeklyNames).toEqual([
      ["チキンクリーム"],
      ["チキントマトソース"],
      ["チキントマトソース"],
      ["チキントマトソース"],
      ["チキントマトソース"],
      []
    ]);

    for (const day of dates) {
      expect(
        result.menusByDate
          .get(`2026-07-${day}`)
          ?.menuItems.filter((item) => item.categoryLabel === "今日のパスタ")
          .map((item) => item.name)
      ).toEqual([`日替り${day}`]);
    }
  });

  it("keeps an explicit in-table cafeteria closure authoritative over printed menu rows", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [
          { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
          { text: "夕定食", page: 1, x: 0, y: 300, width: 40, height: 10 },
          { text: "＜工大350＞", page: 1, x: 100, y: 650, width: 50, height: 10 },
          { text: "唐揚", page: 1, x: 100, y: 630, width: 40, height: 10 },
          { text: "臨時休業", page: 1, x: 100, y: 580, width: 50, height: 10 }
        ]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    const monday = result.menusByDate.get("2026-07-06");
    expect(monday?.status).toBe("closed");
    expect(monday?.menuItems).toEqual([]);
    expect(monday?.unassignedLines).toContain("臨時休業");
    expect(monday?.parser.warnings).not.toContain("closure_notice_subject_unknown");
  });

  it("marks an in-table closed notice without daily menu evidence as closed", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [
          { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
          { text: "夕定食", page: 1, x: 0, y: 300, width: 40, height: 10 },
          { text: "臨時休業", page: 1, x: 100, y: 580, width: 50, height: 10 }
        ]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    const monday = result.menusByDate.get("2026-07-06");
    expect(monday?.status).toBe("closed");
    expect(monday?.menuItems).toEqual([]);
  });

  it("applies an explicit cafeteria footer closure to the document", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [
          { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
          { text: "夕定食", page: 1, x: 0, y: 300, width: 40, height: 10 },
          { text: "＜工大350＞", page: 1, x: 100, y: 650, width: 50, height: 10 },
          { text: "唐揚", page: 1, x: 100, y: 630, width: 40, height: 10 },
          { text: "津田沼食堂は臨時休業します", page: 1, x: 80, y: 200, width: 160, height: 10 }
        ]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    const monday = result.menusByDate.get("2026-07-06");
    expect(monday?.status).toBe("closed");
    expect(monday?.menuItems).toEqual([]);
    expect(result.notices[0]).toMatchObject({
      subject: "cafeteria",
      appliesTo: { kind: "document" },
      matchedRule: "closure.cafeteria.explicit_subject"
    });
  });

  it("preserves an unknown-subject closure for diagnostics without publishing menu items", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [
          { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
          { text: "夕定食", page: 1, x: 0, y: 300, width: 40, height: 10 },
          { text: "＜工大350＞", page: 1, x: 100, y: 650, width: 50, height: 10 },
          { text: "唐揚", page: 1, x: 100, y: 630, width: 40, height: 10 },
          { text: "施設都合により休業します", page: 1, x: 80, y: 200, width: 150, height: 10 }
        ]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    const monday = result.menusByDate.get("2026-07-06");
    expect(monday?.status).toBe("unknown");
    expect(monday?.menuItems).toEqual([]);
    expect(monday?.menuText.rawText).toContain("施設都合により休業します");
    expect(monday?.unassignedLines).toContain("施設都合により休業します");
    expect(monday?.parser.warnings).toContain("closure_notice_subject_unknown");
  });

  it("does not remove a legitimate menu name containing 休み", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [
          { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
          { text: "夕定食", page: 1, x: 0, y: 300, width: 40, height: 10 },
          { text: "＜工大350＞", page: 1, x: 100, y: 650, width: 50, height: 10 },
          { text: "箸休み小鉢", page: 1, x: 100, y: 630, width: 60, height: 10 }
        ]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    const monday = result.menusByDate.get("2026-07-06");
    expect(monday?.status).toBe("ok");
    expect(monday?.menuItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "箸休み小鉢", priceYen: 350 })])
    );
  });

  it("structures current New Narashino fixtures without the known high-confidence false items", () => {
    const firstFloor = parseLocationPdf(
      fetchedPdf("shinnarashino-1f"),
      loadFixture("shinnarashino-1f-20260706.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-07"
    );
    const secondFloor = parseLocationPdf(
      fetchedPdf("shinnarashino-2f"),
      loadFixture("shinnarashino-2f-20260706.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-07"
    );

    const firstFloorMonday = firstFloor.menusByDate.get("2026-07-06");
    expect(firstFloorMonday?.menuItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "asa_teishoku", name: "れんこん 海老はさみ揚", priceYen: 300 }),
        expect.objectContaining({ category: "teishoku", name: "カキフライ", priceYen: 400 }),
        expect.objectContaining({ category: "teishoku", name: "温玉のせ 豚キムチ丼", priceYen: 350 }),
        expect.objectContaining({ category: "curry", name: "カレー", priceYen: 250 }),
        expect.objectContaining({ category: "side_dish", name: "コロッケ", priceYen: 50 })
      ])
    );
    expect(firstFloorMonday?.menuItems.map((item) => item.name)).not.toContain("大盛カレー");

    const firstFloorSaturday = firstFloor.menusByDate.get("2026-07-11");
    expect(firstFloorSaturday?.status).toBe("not_published");
    expect(firstFloorSaturday?.menuItems).toEqual([]);
    expect(firstFloorSaturday?.menuItems.map((item) => item.name)).not.toContain("営業中");

    const secondFloorFriday = secondFloor.menusByDate.get("2026-07-10");
    expect(secondFloorFriday?.menuItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "donburi", name: "ハッシュドビーフ", priceYen: 400 }),
        expect.objectContaining({ category: "curry", name: "スティックフライド チキン", priceYen: 350 }),
        expect.objectContaining({ category: "keishoku_pasta", name: "塩豚チーズ", priceYen: 350 }),
        expect.objectContaining({ category: "side_dish", name: "ポテト", priceYen: 100 })
      ])
    );
    expect(secondFloorFriday?.menuItems.some((item) => item.category === "unknown")).toBe(false);
    expect(secondFloorFriday?.menuItems.map((item) => item.name)).not.toEqual(
      expect.arrayContaining(["ホームパン¥", "2F食堂"])
    );
  });

  it("does not structure menuItems for non-ok location days", () => {
    const result = parseLocationPdf(
      fetchedPdf(),
      {
        pageCount: 1,
        warnings: [],
        items: [{ text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 }]
      },
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    const menu = result.menusByDate.get("2026-07-06");
    expect(menu?.status).toBe("not_published");
    expect(menu?.menuItems).toEqual([]);
  });

  it("marks missing weekday fallback as closed when the PDF has a weekday closed notice", () => {
    const result = parseLocationPdf(
      fetchedPdf("shinnarashino-2f"),
      loadFixture("shinnarashino-2f-20260706.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-07"
    );

    expect(result.menusByDate.has("2026-07-11")).toBe(false);
    const fallback = fallbackLocationMenu(result, "2026-07-11");
    expect(fallback.status).toBe("closed");
    expect(fallback.statusMessage).toContain("土曜日休業");
  });

  it("warns when New Narashino profile rows are not detected", () => {
    const firstFloor = parseLocationPdf(
      fetchedPdf("shinnarashino-1f"),
      loadFixture("shinnarashino-1f-single-block.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );
    const secondFloor = parseLocationPdf(
      fetchedPdf("shinnarashino-2f"),
      loadFixture("shinnarashino-2f-single-block.json"),
      DEFAULT_PDF_LIMITS,
      "2026-07-03"
    );

    expect(firstFloor.warnings).toEqual(
      expect.arrayContaining([
        "profile_rows_not_detected:shared:curry",
        "profile_rows_not_detected:shared:side_dish",
        "profile_rows_not_detected:daily:men_corner"
      ])
    );
    expect(secondFloor.warnings).toContain("profile_rows_not_detected:shared:side_dish");
  });
});

describe("parser output characterization snapshots", () => {
  for (const fixture of tsudanumaCharacterizationFixtures) {
    it(`keeps Tsudanuma golden output for ${fixture.name}`, () => {
      const result = parseLocationPdf(
        fetchedPdf("tsudanuma"),
        loadFixture(fixture.fixture),
        DEFAULT_PDF_LIMITS,
        fixture.referenceDate
      );

      expect(parserCharacterizationSnapshot(result)).toMatchSnapshot();
    });
  }

  for (const fixture of shinnarashinoLegacyBehaviorFixtures) {
    it(`records current parser behavior for ${fixture.name}`, () => {
      const result = parseLocationPdf(
        fetchedPdf(fixture.locationId),
        loadFixture(fixture.fixture),
        DEFAULT_PDF_LIMITS,
        fixture.referenceDate
      );

      expect(parserCharacterizationSnapshot(result)).toMatchSnapshot();
    });
  }

  for (const fixture of shinnarashinoIntendedOutputFixtures) {
    it(`keeps intended Shin-Narashino output for ${fixture.name}`, () => {
      const result = parseLocationPdf(
        fetchedPdf(fixture.locationId),
        loadFixture(fixture.fixture),
        DEFAULT_PDF_LIMITS,
        fixture.referenceDate
      );

      expect(parserCharacterizationSnapshot(result)).toMatchSnapshot();
    });
  }
});
