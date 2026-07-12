import { describe, expect, it } from "vitest";
import type { PdfOperatorPage } from "./pdfOperatorSource";
import { extractPdfRulings } from "./pdfRulings";

const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  constructPath: 4,
  stroke: 5,
  closeStroke: 6,
  fill: 7,
  eoFill: 8,
  fillStroke: 9,
  eoFillStroke: 10,
  closeFillStroke: 11,
  closeEOFillStroke: 12,
  endPath: 13
} as const;

describe("PDF rulings", () => {
  it("extracts axis-aligned stroked paths through the CTM", () => {
    const result = extractPdfRulings(
      page(
        [OPS.transform, OPS.constructPath],
        [
          [1, 0, 0, 1, 10, 20],
          [OPS.stroke, [new Float32Array([0, 0, 0, 1, 0, 100, 1, 50, 100])], new Float32Array([0, 0, 50, 100])]
        ]
      )
    );

    expect(result.geometry.rulings).toEqual([
      { orientation: "vertical", position: 10, start: 20, end: 120, source: "stroke" },
      { orientation: "horizontal", position: 120, start: 10, end: 60, source: "stroke" }
    ]);
  });

  it("accepts a thin repeated-shape candidate but ignores endPath clip rectangles", () => {
    const rectangle = new Float32Array([0, 20, 10, 1, 21, 10, 1, 21, 90, 1, 20, 90, 4]);
    const result = extractPdfRulings(
      page(
        [OPS.constructPath, OPS.constructPath],
        [
          [OPS.eoFill, [rectangle], new Float32Array([20, 10, 21, 90])],
          [OPS.endPath, [rectangle], new Float32Array([20, 10, 21, 90])]
        ]
      )
    );

    expect(result.geometry.rulings).toEqual([
      { orientation: "vertical", position: 20.5, start: 10, end: 90, source: "thin_fill" }
    ]);
  });

  it("fails open when constructPath uses an unknown internal shape", () => {
    const result = extractPdfRulings(page([OPS.constructPath], [[OPS.stroke, [new Float32Array([99, 0, 0])], []]]));

    expect(result.geometry.rulings).toEqual([]);
    expect(result.warnings).toEqual(["pdf_ruling_construct_path_unsupported"]);
  });
});

function page(fnArray: number[], argsArray: unknown[]): PdfOperatorPage {
  return {
    pageNumber: 1,
    view: { left: 0, bottom: 0, right: 600, top: 800 },
    fnArray,
    argsArray,
    runtime: { ops: OPS, version: "test" }
  };
}
