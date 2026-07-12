import { describe, expect, it } from "vitest";
import { INGEST_USER_AGENT } from "./fetchDiagnostics";
import { __test__, DEFAULT_PDF_LIMITS, fetchPdf, PdfFetchError } from "./pdf";
import type { PdfOperatorPage, PdfOperatorRuntime } from "./pdfOperatorSource";
import { collectPdfOperatorTextRuns } from "./pdfTextOperators";
import { recoverPageEdgeTextAffixes } from "./pdfTextRecovery";
import type { IngestSource } from "./sources";

const SOURCE: IngestSource = {
  locationId: "tsudanuma",
  sourcePageUrl: "https://www.cit-s.com/dining/",
  pdfUrl: "https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/t.pdf",
  discovered: true,
  warnings: []
};

describe("PDF fetch", () => {
  it("classifies request network errors as fetch_failed", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["user-agent"]).toBe(INGEST_USER_AGENT);
      throw errorWithCause("ECONNRESET", "Error");
    };

    await expect(fetchPdf(SOURCE, DEFAULT_PDF_LIMITS, fetchImpl)).rejects.toMatchObject({
      status: "fetch_failed",
      warnings: ["pdf_fetch_network_econnreset"]
    });
    await expect(fetchPdf(SOURCE, DEFAULT_PDF_LIMITS, fetchImpl)).rejects.toBeInstanceOf(PdfFetchError);
  });

  it("classifies body read network errors as fetch_failed", async () => {
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => {
          throw errorWithCause("UND_ERR_BODY_TIMEOUT", "BodyTimeoutError");
        }
      }) as unknown as Response;

    await expect(fetchPdf(SOURCE, DEFAULT_PDF_LIMITS, fetchImpl)).rejects.toMatchObject({
      status: "fetch_failed",
      warnings: ["pdf_fetch_network_und_err_body_timeout"]
    });
  });

  it("keeps hard size limit failures distinct from fetch failures", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-length": String(DEFAULT_PDF_LIMITS.hardMaxSourcePdfBytes + 1) }
      });

    await expect(fetchPdf(SOURCE, DEFAULT_PDF_LIMITS, fetchImpl)).rejects.toMatchObject({
      status: "source_too_large",
      warnings: ["source_pdf_hard_size_limit_exceeded"]
    });
  });
});

describe("clipped PDF text recovery", () => {
  it("tracks explicit text state, glyph spacing, and page placement", () => {
    const runs = collectPdfOperatorTextRuns(
      operatorPage(
        [OPS.beginText, OPS.setFont, OPS.setCharSpacing, OPS.setTextMatrix, OPS.showText, OPS.endText],
        [[], ["font-1", 10], [2], [1, 0, 0, 1, -12, 100], [[operatorGlyph("白"), operatorGlyph("身")]], []]
      )
    );

    expect(runs).toEqual([
      expect.objectContaining({
        text: "白身",
        fontName: "font-1",
        baselineY: 100,
        bounds: expect.objectContaining({ left: -12, right: 12 })
      })
    ]);
  });

  it("requires a fresh text matrix after showText or unsupported positioning", () => {
    const consecutive = collectPdfOperatorTextRuns(
      operatorPage(
        [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.showText, OPS.endText],
        [[], ["font-1", 10], [1, 0, 0, 1, 0, 100], [[operatorGlyph("白")]], [[operatorGlyph("身")]], []]
      )
    );
    const moved = collectPdfOperatorTextRuns(
      operatorPage(
        [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.moveText, OPS.showText, OPS.endText],
        [[], ["font-1", 10], [1, 0, 0, 1, 0, 100], [10, 0], [[operatorGlyph("白")]], []]
      )
    );

    expect(consecutive.map((run) => run.text)).toEqual(["白"]);
    expect(moved).toEqual([]);
  });

  it("recovers a leading glyph only when its bounds are outside page.view", () => {
    const item = textItem("身フライ", 0, 40);
    const result = recoverPageEdgeTextAffixes([item], [operatorRun("白身フライ", -10)], PAGE_VIEW);

    expect(result.items[0].text).toBe("白身フライ");
    expect(result.items[0]).toMatchObject({ x: 0, width: 40 });
    expect(result.diagnostics[0]).toMatchObject({
      code: "pdf_text_edge_affix_recovered",
      before: "身フライ",
      after: "白身フライ",
      clippedBy: "page"
    });
  });

  it("recovers a short trailing glyph at the page edge", () => {
    const item = textItem("カレー", 10, 30);
    const result = recoverPageEdgeTextAffixes([item], [operatorRun("カレー丼", 10)], {
      ...PAGE_VIEW,
      right: 40
    });

    expect(result.items[0].text).toBe("カレー丼");
  });

  it("does not guess when multiple affix expansions fit", () => {
    const item = textItem("身フライ", 0, 40);
    const result = recoverPageEdgeTextAffixes(
      [item],
      [operatorRun("白身フライ", -10), operatorRun("半身フライ", -10)],
      PAGE_VIEW
    );

    expect(result.items[0].text).toBe("身フライ");
    expect(result.warnings).toEqual(["pdf_text_edge_affix_recovery_ambiguous"]);
  });

  it("does not rewrite internal differences or non-clipped affixes", () => {
    const internal = textItem("玉子の", 10, 30);
    const visiblePrefix = textItem("身フライ", 20, 40);
    const result = recoverPageEdgeTextAffixes(
      [internal, visiblePrefix],
      [operatorRun("温玉のせ", 10), operatorRun("白身フライ", 10)],
      PAGE_VIEW
    );

    expect(result.items.map((item) => item.text)).toEqual(["玉子の", "身フライ"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reserves an exact text item before considering a clipped affix candidate", () => {
    const exact = textItem("白身フライ", -10, 50);
    const clipped = textItem("身フライ", 0, 40);
    const result = recoverPageEdgeTextAffixes([exact, clipped], [operatorRun("白身フライ", -10)], PAGE_VIEW);

    expect(result.items.map((item) => item.text)).toEqual(["白身フライ", "身フライ"]);
  });

  it("keeps text and empty geometry when the optional operator list fails", async () => {
    const result = await __test__.extractWithDocumentProxy(
      async () => ({
        numPages: 1,
        getPage: async () => ({
          view: [0, 0, 100, 200],
          getTextContent: async () => ({
            items: [
              {
                str: "身フライ",
                transform: [1, 0, 0, 1, 0, 100],
                width: 40,
                height: 10,
                fontName: "font-1"
              }
            ]
          }),
          getOperatorList: async () => {
            throw new Error("operator list unavailable");
          }
        })
      }),
      new Uint8Array([1]),
      { value: RUNTIME, warnings: [] }
    );

    expect(result.items[0].text).toBe("身フライ");
    expect(result.pageGeometry).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.warnings).toContain("pdf_operator_list_unavailable");
  });
});

const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  beginText: 4,
  endText: 5,
  setFont: 6,
  setHScale: 7,
  setCharSpacing: 8,
  setWordSpacing: 9,
  setTextMatrix: 10,
  moveText: 11,
  setLeadingMoveText: 12,
  nextLine: 13,
  nextLineShowText: 14,
  nextLineSetSpacingShowText: 15,
  showText: 16
} as const;

const RUNTIME: PdfOperatorRuntime = { ops: OPS, version: "test" };
const PAGE_VIEW = { left: 0, bottom: 0, right: 100, top: 200 };

function operatorPage(fnArray: number[], argsArray: unknown[]): PdfOperatorPage {
  return { pageNumber: 1, view: PAGE_VIEW, fnArray, argsArray, runtime: RUNTIME };
}

function textItem(text: string, x: number, width: number) {
  return {
    text,
    page: 1,
    x,
    y: 100,
    width,
    height: 10,
    fontName: "font-1"
  };
}

function operatorRun(text: string, x: number) {
  return {
    page: 1,
    text,
    fontName: "font-1",
    baselineY: 100,
    bounds: { left: x, bottom: 100, right: x + Array.from(text).length * 10, top: 110 },
    glyphs: Array.from(text).map((character, index) => ({
      text: character,
      bounds: { left: x + index * 10, bottom: 100, right: x + (index + 1) * 10, top: 110 }
    }))
  };
}

function operatorGlyph(text: string) {
  return { unicode: text, width: 1000 };
}
function errorWithCause(code: string, name: string): Error {
  const error = new TypeError("fetch failed");
  const cause = new Error(`network cause ${code}`) as Error & { code: string };
  cause.name = name;
  cause.code = code;
  Object.defineProperty(error, "cause", { value: cause });
  return error;
}
