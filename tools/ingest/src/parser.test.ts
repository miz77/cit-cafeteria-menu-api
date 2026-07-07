import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { __test__, parseLocationPdf } from "./parser";
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

const shinnarashinoCurrentBehaviorFixtures = [
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
  },
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

  it("structures New Narashino price rows conservatively", () => {
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

    const secondFloorItems = Array.from(secondFloor.menusByDate.values()).flatMap((menu) => menu.menuItems);
    expect(secondFloorItems.length).toBeGreaterThan(0);
    expect(secondFloorItems.every((item) => item.priceYen !== null)).toBe(true);

    const firstFloorPriceMissing = Array.from(firstFloor.menusByDate.values())
      .flatMap((menu) => menu.menuItems)
      .filter((item) => item.priceYen === null);
    expect(firstFloorPriceMissing.length).toBeGreaterThan(0);
    expect(firstFloorPriceMissing.every((item) => item.warnings.includes("price_not_found"))).toBe(true);
    expect(
      Array.from(firstFloor.menusByDate.values()).some((menu) => menu.unassignedLines.includes("大盛販売ありません"))
    ).toBe(true);
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

  for (const fixture of shinnarashinoCurrentBehaviorFixtures) {
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
});
