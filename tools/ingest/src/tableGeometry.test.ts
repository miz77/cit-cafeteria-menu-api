import { describe, expect, it } from "vitest";
import type { PdfTextItem } from "./pdf";
import type { PdfPageGeometry, PdfRuling } from "./pdfRulings";
import { inferMergedColumnSpans, type DateColumnGeometry } from "./tableGeometry";

const COLUMNS: DateColumnGeometry[] = Array.from({ length: 6 }, (_, index) => ({
  page: 1,
  left: index * 100,
  right: (index + 1) * 100
}));

describe("table geometry", () => {
  it("expands a row only across physically proven missing boundaries", () => {
    const items = [item("チキンクリーム", 10, 80), item("チキントマトソース", 320, 160)];
    const result = inferMergedColumnSpans(items, COLUMNS, pageGeometry());

    expect(result.spansByItemIndex.get(0)).toBeUndefined();
    expect(result.spansByItemIndex.get(1)).toEqual({ firstColumn: 1, lastColumnExclusive: 5 });
  });

  it("does not infer a merge when a missing boundary lacks adjacent-row evidence", () => {
    const geometry = pageGeometry().map((page) => ({
      ...page,
      rulings: page.rulings.filter((ruling) => ruling.position !== 300)
    }));
    const result = inferMergedColumnSpans([item("short", 320, 40)], COLUMNS, geometry);

    expect(result.spansByItemIndex.size).toBe(0);
    expect(result.warnings).toEqual(["ambiguous_column_span_not_expanded"]);
  });

  it("does not accept a lone thin rectangle as a table boundary", () => {
    const geometry = pageGeometry().map((page) => ({
      ...page,
      rulings: [
        ...page.rulings.filter((ruling) => Math.abs(ruling.position - 300) > 1),
        vertical(300, 60, 99.8, "thin_fill")
      ]
    }));
    const result = inferMergedColumnSpans([item("short", 320, 40)], COLUMNS, geometry);

    expect(result.spansByItemIndex.size).toBe(0);
    expect(result.warnings).toEqual(["ambiguous_column_span_not_expanded"]);
  });

  it("does not expand across another column containing distinct row text", () => {
    const result = inferMergedColumnSpans(
      [item("ガパオライス", 120, 60), item("コムスン", 220, 60), item("annotation", 320, 40)],
      COLUMNS,
      pageGeometry()
    );

    expect(result.spansByItemIndex.size).toBe(0);
    expect(result.ambiguousItemIndexes.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual(["ambiguous_column_span_not_expanded"]);
  });

  it("fails open when page geometry is unavailable", () => {
    const result = inferMergedColumnSpans([item("チキントマトソース", 320, 160)], COLUMNS, []);

    expect(result.spansByItemIndex.size).toBe(0);
    expect(result.ambiguousItemIndexes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

function item(text: string, x: number, width: number): PdfTextItem {
  return { text, page: 1, x, y: 110, width, height: 20 };
}

function pageGeometry(): PdfPageGeometry[] {
  const rulings: PdfRuling[] = [horizontal(100), horizontal(140)];
  for (const position of [0, 100, 500, 600]) {
    rulings.push(vertical(position, 80, 160, "stroke"));
  }
  for (const position of [200, 300, 400]) {
    rulings.push(vertical(position, 60, 100, "stroke"));
    rulings.push(vertical(position + 0.4, 60, 99.8, "thin_fill"));
  }
  return [{ page: 1, view: { left: 0, bottom: 0, right: 600, top: 800 }, rulings }];
}

function horizontal(position: number): PdfRuling {
  return { orientation: "horizontal", position, start: 0, end: 600, source: "stroke" };
}

function vertical(position: number, start: number, end: number, source: PdfRuling["source"]): PdfRuling {
  return { orientation: "vertical", position, start, end, source };
}
