import { describe, expect, it } from "vitest";
import { PdfCtmState, transformPdfBounds } from "./pdfGraphicsState";
import { loadPdfOperatorPage, resolvePdfOperatorRuntime } from "./pdfOperatorSource";

describe("PDF operator source", () => {
  it("characterizes the bundled PDF.js operator runtime", async () => {
    const unpdf = await import("unpdf");
    const result = await resolvePdfOperatorRuntime(unpdf.getResolvedPDFJS);

    expect(result.value?.version).toBe("5.6.205");
    expect(result.value?.ops).toMatchObject({
      save: expect.any(Number),
      restore: expect.any(Number),
      transform: expect.any(Number),
      constructPath: expect.any(Number),
      setTextMatrix: expect.any(Number),
      showText: expect.any(Number)
    });
  });

  it("resolves PDF.js OPS without depending on unrelated runtime fields", async () => {
    const result = await resolvePdfOperatorRuntime(async () => ({
      OPS: { save: 10, restore: 11 },
      version: "5.6.205"
    }));

    expect(result).toEqual({
      value: { ops: { save: 10, restore: 11 }, version: "5.6.205" },
      warnings: []
    });
  });

  it("fails open when the runtime or operator list is unavailable", async () => {
    await expect(resolvePdfOperatorRuntime(async () => Promise.reject(new Error("unavailable")))).resolves.toEqual({
      value: null,
      warnings: ["pdf_operator_runtime_unavailable"]
    });

    await expect(
      loadPdfOperatorPage(
        { view: [0, 0, 100, 200], getOperatorList: async () => Promise.reject(new Error("broken")) },
        1,
        { ops: { showText: 44 }, version: null }
      )
    ).resolves.toEqual({ value: null, warnings: ["pdf_operator_list_unavailable"] });
  });

  it("validates view, parallel arrays, and the operator limit", async () => {
    const runtime = { ops: { showText: 44 }, version: null };
    const invalid = await loadPdfOperatorPage(
      { view: [0, 0, 100, 200], getOperatorList: async () => ({ fnArray: [44], argsArray: [] }) },
      1,
      runtime
    );
    expect(invalid.warnings).toEqual(["pdf_operator_list_invalid"]);

    const limited = await loadPdfOperatorPage(
      { view: [0, 0, 100, 200], getOperatorList: async () => ({ fnArray: [44, 44], argsArray: [[], []] }) },
      1,
      runtime,
      1
    );
    expect(limited.warnings).toEqual(["pdf_operator_limit_exceeded"]);
  });

  it("loads typed operator arrays and normalizes the page view", async () => {
    const runtime = { ops: { showText: 44 }, version: "5.6.205" };
    const result = await loadPdfOperatorPage(
      {
        view: new Float32Array([100, 200, 0, 0]),
        getOperatorList: async () => ({ fnArray: new Uint8Array([44]), argsArray: [["glyphs"]] })
      },
      2,
      runtime
    );

    expect(result.value).toEqual({
      pageNumber: 2,
      view: { left: 0, bottom: 0, right: 100, top: 200 },
      fnArray: [44],
      argsArray: [["glyphs"]],
      runtime
    });
  });
});

describe("PDF graphics transforms", () => {
  it("tracks nested CTM save, transform, and restore", () => {
    const state = new PdfCtmState();
    state.transform([2, 0, 0, 2, 10, 20]);
    state.save();
    state.transform([1, 0, 0, 1, 5, 6]);
    expect(state.current()).toEqual([2, 0, 0, 2, 20, 32]);
    expect(state.restore()).toBe(true);
    expect(state.current()).toEqual([2, 0, 0, 2, 10, 20]);
    expect(state.restore()).toBe(false);
  });

  it("transforms all bounds corners", () => {
    expect(transformPdfBounds({ left: 0, bottom: 0, right: 10, top: 20 }, [0, 1, -1, 0, 100, 50])).toEqual({
      left: 80,
      bottom: 50,
      right: 100,
      top: 60
    });
  });
});
