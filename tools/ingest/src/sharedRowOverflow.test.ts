import { describe, expect, it } from "vitest";
import type { PdfEdgeOverflowMenuEvidence } from "./pdfEdgeOverflow";
import { resolveSharedRowOverflow } from "./sharedRowOverflow";

const EVIDENCE: PdfEdgeOverflowMenuEvidence = {
  page: 1,
  name: "ライス",
  priceYen: 100,
  side: "left",
  bounds: { left: -190, bottom: 328, right: -25, top: 357 },
  baselineY: 328.82,
  sourceRunIndexes: [1, 2]
};

describe("shared-row overflow resolution", () => {
  it("assigns evidence to exactly one matching row band", () => {
    const result = resolveSharedRowOverflow([EVIDENCE], [{ id: "side", page: 1, minY: 325, maxY: 335 }]);

    expect(result.evidenceByRowId.get("side")).toEqual([EVIDENCE]);
    expect(result.warnings).toEqual([]);
  });

  it("does not guess when no row or multiple rows match", () => {
    const unassigned = resolveSharedRowOverflow([EVIDENCE], []);
    const ambiguous = resolveSharedRowOverflow(
      [EVIDENCE],
      [
        { id: "one", page: 1, minY: 325, maxY: 335 },
        { id: "two", page: 1, minY: 320, maxY: 340 }
      ]
    );

    expect(unassigned.evidenceByRowId.size).toBe(0);
    expect(unassigned.warnings).toEqual(["pdf_text_edge_overflow_unassigned"]);
    expect(ambiguous.evidenceByRowId.size).toBe(0);
    expect(ambiguous.warnings).toEqual(["pdf_text_edge_overflow_ambiguous"]);
  });
});
