import { describe, expect, it } from "vitest";
import { collectPdfEdgeOverflowMenuEvidence } from "./pdfEdgeOverflow";
import type { PdfOperatorTextRun } from "./pdfTextOperators";

const PAGE_VIEW = { left: 0, bottom: 0, right: 595.2, top: 841.68 };

describe("PDF edge-overflow menu evidence", () => {
  it("collects complete off-page name and price pairs using visible row typography", () => {
    const runs = currentSideDishRuns();
    const result = collectPdfEdgeOverflowMenuEvidence(runs, PAGE_VIEW);

    expect(result.evidence).toEqual([
      expect.objectContaining({ name: "ライス", priceYen: 100, side: "left", sourceRunIndexes: [0, 1] }),
      expect.objectContaining({ name: "味噌汁", priceYen: 50, side: "right", sourceRunIndexes: [5, 6] })
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("normalizes full-width price markers and digits split across runs", () => {
    const runs = currentSideDishRuns();
    runs[0] = run("ライス￥", -190, -85, "name");
    runs[1] = run("１００", -85, -25, "price");

    expect(collectPdfEdgeOverflowMenuEvidence(runs, PAGE_VIEW).evidence[0]).toMatchObject({
      name: "ライス",
      priceYen: 100
    });
  });

  it("does not reuse runs claimed by exact or affix text recovery", () => {
    const result = collectPdfEdgeOverflowMenuEvidence(currentSideDishRuns(), PAGE_VIEW, new Set([0]));

    expect(result.evidence.map((item) => item.name)).toEqual(["味噌汁"]);
  });

  it("rejects incomplete pairs, internal hidden text, and typography without a visible anchor", () => {
    const incomplete = [
      run("ライス￥", -190, -85, "name"),
      run("唐揚￥１", 15, 120, "name"),
      run("５０", 120, 160, "price")
    ];
    const internal = [
      run("ライス￥", 200, 300, "name"),
      run("１００", 300, 360, "price"),
      run("唐揚￥１", 15, 120, "name"),
      run("５０", 120, 160, "price")
    ];
    const noAnchor = [run("ライス￥", -190, -85, "other"), run("１００", -85, -25, "price")];

    expect(collectPdfEdgeOverflowMenuEvidence(incomplete, PAGE_VIEW).evidence).toEqual([]);
    expect(collectPdfEdgeOverflowMenuEvidence(incomplete, PAGE_VIEW).warnings).toContain(
      "pdf_text_edge_overflow_incomplete_pair"
    );
    expect(collectPdfEdgeOverflowMenuEvidence(internal, PAGE_VIEW).evidence).toEqual([]);
    expect(collectPdfEdgeOverflowMenuEvidence(noAnchor, PAGE_VIEW).evidence).toEqual([]);
  });

  it("does not require equal spacing between cells", () => {
    const runs = currentSideDishRuns();
    runs[0] = run("ライス￥", -400, -285, "name");
    runs[1] = run("１００", -285, -225, "price");

    expect(collectPdfEdgeOverflowMenuEvidence(runs, PAGE_VIEW).evidence[0]).toMatchObject({ name: "ライス" });
  });
});

function currentSideDishRuns(): PdfOperatorTextRun[] {
  return [
    run("ライス￥", -191.42, -86.3, "name"),
    run("100", -86.28, -24.36, "price"),
    run("唐揚￥１", 14.06, 118.61, "name"),
    run("50", 118.63, 162.41, "price"),
    run("サラダ￥", 435.22, 546.39, "name"),
    run("味噌汁￥", 628.61, 743.81, "name"),
    run("50", 743.83, 787.61, "price")
  ];
}

function run(text: string, left: number, right: number, fontName: string): PdfOperatorTextRun {
  return {
    page: 1,
    text,
    fontName,
    baselineY: 328.82,
    bounds: { left, bottom: 328.82, right, top: 357.62 },
    glyphs: [{ text, bounds: { left, bottom: 328.82, right, top: 357.62 } }]
  };
}
