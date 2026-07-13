import { describe, expect, it } from "vitest";
import { collectPdfEdgeOverflowEvidence } from "./pdfEdgeOverflow";
import type { PdfOperatorTextRun } from "./pdfTextOperators";

const PAGE_VIEW = { left: 0, bottom: 0, right: 595.2, top: 841.68 };
const VISIBLE_CLAIMS = { matchedVisibleRunIndexes: [2, 3, 4], blockedRunIndexes: [] };

describe("PDF edge-overflow evidence", () => {
  it("keeps the nearest connected groups without interpreting menu text", () => {
    const result = collectPdfEdgeOverflowEvidence(currentSideDishRuns(), PAGE_VIEW, VISIBLE_CLAIMS);

    expect(result.groups).toEqual([
      expect.objectContaining({
        side: "left",
        edgeGap: expect.closeTo(24.36),
        runs: [expect.objectContaining({ text: "ライス￥" }), expect.objectContaining({ text: "100" })],
        visibleAnchors: expect.arrayContaining([expect.objectContaining({ text: "唐揚￥１" })])
      }),
      expect.objectContaining({
        side: "right",
        edgeGap: expect.closeTo(33.41),
        runs: [expect.objectContaining({ text: "味噌汁￥" }), expect.objectContaining({ text: "50" })]
      })
    ]);
    expect(result.diagnostics.every((item) => item.code === "pdf_text_edge_candidate_detected")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("uses only getTextContent-matched runs as visible anchors", () => {
    const result = collectPdfEdgeOverflowEvidence(currentSideDishRuns(), PAGE_VIEW, {
      matchedVisibleRunIndexes: [],
      blockedRunIndexes: []
    });

    expect(result.groups.every((group) => group.visibleAnchors.length === 0)).toBe(true);
  });

  it("does not reuse blocked or visible-matched off-page runs", () => {
    const result = collectPdfEdgeOverflowEvidence(currentSideDishRuns(), PAGE_VIEW, {
      matchedVisibleRunIndexes: [0, 2, 3, 4],
      blockedRunIndexes: [5]
    });

    expect(result.groups.map((group) => group.runs.map((run) => run.text))).toEqual([["100"], ["50"]]);
  });

  it("keeps nearly identical baselines together across a rounding boundary", () => {
    const runs = currentSideDishRuns();
    runs[0] = run("ライス￥", -191.42, -86.3, "name", 328.49);
    runs[1] = run("100", -86.28, -24.36, "price", 328.51);

    const result = collectPdfEdgeOverflowEvidence(runs, PAGE_VIEW, VISIBLE_CLAIMS);
    expect(result.groups[0].runs.map((item) => item.text)).toEqual(["ライス￥", "100"]);
  });

  it("does not skip a nearer unrelated run to recover a farther complete pair", () => {
    const runs = [...currentSideDishRuns(), run("旧", -10, 0, "name")];
    const result = collectPdfEdgeOverflowEvidence(runs, PAGE_VIEW, VISIBLE_CLAIMS);
    const left = result.groups.find((group) => group.side === "left");

    expect(left?.runs.map((item) => item.text)).toEqual(["旧"]);
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

function run(text: string, left: number, right: number, fontName: string, baselineY = 328.82): PdfOperatorTextRun {
  return {
    page: 1,
    text,
    fontName,
    baselineY,
    bounds: { left, bottom: baselineY, right, top: baselineY + 28.8 },
    glyphs: [{ text, bounds: { left, bottom: baselineY, right, top: baselineY + 28.8 } }]
  };
}
