import { describe, expect, it } from "vitest";
import type { PdfOffPageTextGroup } from "./pdfEdgeOverflow";
import { resolveSharedRowOverflow } from "./sharedRowOverflow";

const BAND = { id: "side", page: 1, minY: 325, maxY: 335 };

describe("shared-row overflow resolution", () => {
  it("recovers one complete, anchored, edge-adjacent price pair", () => {
    const result = resolveSharedRowOverflow([group("ライス￥", "１００", "left", 24)], [BAND]);

    expect(result.recoveredByRowId.get("side")).toEqual([
      expect.objectContaining({ name: "ライス", priceYen: 100, side: "left" })
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "pdf_text_edge_shared_item_recovered",
        rowId: "side",
        maxEdgeGap: expect.closeTo(57.6)
      })
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("completes a pair from one edge-connected visible name and an off-page price", () => {
    const result = resolveSharedRowOverflow([splitAtRightEdgeGroup(0)], [BAND]);

    expect(result.recoveredByRowId.get("side")).toEqual([
      expect.objectContaining({ name: "大盛カレー", priceYen: 300, side: "right" })
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "pdf_text_edge_shared_item_recovered",
        rowId: "side",
        sourceRunIndexes: [8, 9]
      })
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("does not join a visible name to a disconnected off-page price", () => {
    const result = resolveSharedRowOverflow([splitAtRightEdgeGroup(20)], [BAND]);

    expect(result.recoveredByRowId.size).toBe(0);
    expect(result.diagnostics[0].code).toBe("pdf_text_edge_candidate_incomplete_pair");
  });

  it("requires independent visible typography evidence for an edge-connected name", () => {
    const candidate = splitAtRightEdgeGroup(0);
    candidate.visibleAnchors[0] = { ...candidate.visibleAnchors[0], fontName: "other-name" };
    const result = resolveSharedRowOverflow([candidate], [BAND]);

    expect(result.recoveredByRowId.size).toBe(0);
    expect(result.diagnostics[0].code).toBe("pdf_text_edge_candidate_anchor_unverified");
  });

  it("rejects a complete but distant stale cell", () => {
    const result = resolveSharedRowOverflow([group("ライス￥", "100", "left", 225)], [BAND]);

    expect(result.recoveredByRowId.size).toBe(0);
    expect(result.diagnostics[0]).toMatchObject({
      code: "pdf_text_edge_candidate_too_far",
      edgeGap: 225,
      maxEdgeGap: expect.closeTo(57.6)
    });
    expect(result.warnings).toEqual(["pdf_text_edge_candidate_too_far"]);
  });

  it("requires an anchor matched to visible text content", () => {
    const candidate = { ...group("ライス￥", "100", "left", 24), visibleAnchors: [] };
    const result = resolveSharedRowOverflow([candidate], [BAND]);

    expect(result.recoveredByRowId.size).toBe(0);
    expect(result.diagnostics[0].code).toBe("pdf_text_edge_candidate_anchor_unverified");
  });

  it("keeps unassigned incomplete text diagnostic-only", () => {
    const result = resolveSharedRowOverflow([group("注記￥", "", "left", 24)], []);

    expect(result.diagnostics[0].code).toBe("pdf_text_edge_candidate_unassigned");
    expect(result.warnings).toEqual([]);
  });

  it("does not let ambiguity on one side suppress an independent side", () => {
    const firstLeft = group("ライス￥", "100", "left", 24, 328.8);
    const secondLeft = group("パン￥", "120", "left", 20, 329.2);
    const right = group("味噌汁￥", "50", "right", 33, 328.8);
    const result = resolveSharedRowOverflow([firstLeft, secondLeft, right], [BAND]);

    expect(result.recoveredByRowId.get("side")).toEqual([
      expect.objectContaining({ name: "味噌汁", priceYen: 50, side: "right" })
    ]);
    expect(result.warnings).toContain("pdf_text_edge_candidate_ambiguous");
  });

  it("does not guess when multiple row bands match", () => {
    const result = resolveSharedRowOverflow(
      [group("ライス￥", "100", "left", 24)],
      [BAND, { id: "other", page: 1, minY: 320, maxY: 340 }]
    );

    expect(result.recoveredByRowId.size).toBe(0);
    expect(result.diagnostics[0].code).toBe("pdf_text_edge_candidate_ambiguous");
  });
});

function group(
  nameText: string,
  priceText: string,
  side: "left" | "right",
  edgeGap: number,
  baselineY = 328.82
): PdfOffPageTextGroup {
  const left = side === "left" ? -190 : 629;
  return {
    page: 1,
    side,
    baselineY,
    bounds: { left, bottom: baselineY, right: left + 165, top: baselineY + 28.8 },
    edgeGap,
    runs: [
      {
        text: nameText,
        fontName: "name",
        bounds: { left, bottom: baselineY, right: left + 105, top: baselineY + 28.8 },
        sourceRunIndex: 1
      },
      {
        text: priceText,
        fontName: "price",
        bounds: { left: left + 105, bottom: baselineY, right: left + 165, top: baselineY + 28.8 },
        sourceRunIndex: 2
      }
    ],
    visibleAnchors: [
      {
        text: "唐揚￥１",
        fontName: "name",
        bounds: { left: 15, bottom: baselineY, right: 120, top: baselineY + 28.8 },
        sourceRunIndex: 3
      },
      {
        text: "50",
        fontName: "price",
        bounds: { left: 120, bottom: baselineY, right: 164, top: baselineY + 28.8 },
        sourceRunIndex: 4
      }
    ]
  };
}

function splitAtRightEdgeGroup(gap: number): PdfOffPageTextGroup {
  const baselineY = 328.82;
  return {
    page: 1,
    side: "right",
    baselineY,
    bounds: { left: 596 + gap, bottom: baselineY, right: 646 + gap, top: baselineY + 28.8 },
    edgeGap: 1 + gap,
    runs: [
      {
        text: "300",
        fontName: "price",
        bounds: { left: 596 + gap, bottom: baselineY, right: 646 + gap, top: baselineY + 28.8 },
        sourceRunIndex: 9
      }
    ],
    visibleAnchors: [
      {
        text: "サラダ付カレー￥",
        fontName: "name",
        bounds: { left: 300, bottom: baselineY, right: 470, top: baselineY + 28.8 },
        sourceRunIndex: 6
      },
      {
        text: "300",
        fontName: "price",
        bounds: { left: 470, bottom: baselineY, right: 520, top: baselineY + 28.8 },
        sourceRunIndex: 7
      },
      {
        text: "大盛カレー￥",
        fontName: "name",
        bounds: { left: 437, bottom: baselineY, right: 596.3, top: baselineY + 28.8 },
        sourceRunIndex: 8
      }
    ]
  };
}
