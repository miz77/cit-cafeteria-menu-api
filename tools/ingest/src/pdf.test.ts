import { describe, expect, it } from "vitest";
import { INGEST_USER_AGENT } from "./fetchDiagnostics";
import { __test__, DEFAULT_PDF_LIMITS, fetchPdf, PdfFetchError } from "./pdf";
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
  it("reads nested text matrices and glyph widths from a PDF.js operator list", () => {
    const codes = {
      save: 1,
      restore: 2,
      transform: 3,
      setFont: 4,
      setHScale: 5,
      setTextMatrix: 6,
      showText: 7
    };
    const runs = __test__.collectOperatorTextRuns(
      {
        fnArray: [codes.setFont, codes.setTextMatrix, codes.showText],
        argsArray: [
          ["font-1", 10],
          [new Float32Array([1, 0, 0, 1, 10, 100])],
          [[operatorGlyph("白"), operatorGlyph("身")]]
        ]
      },
      codes
    );

    expect(runs).toEqual([
      expect.objectContaining({ text: "白身", fontName: "font-1", x: 10, y: 100, unitScale: 0.01 })
    ]);
  });

  it("recovers a short leading glyph when font and geometry agree", () => {
    const item = textItem("身フライ", 20, 40);
    const result = __test__.recoverClippedTextAffixes([item], [operatorRun("白身フライ", 10)]);

    expect(result.items[0].text).toBe("白身フライ");
    expect(result.recoveredCount).toBe(1);
    expect(result.ambiguousCount).toBe(0);
  });

  it("recovers a short trailing glyph when font and geometry agree", () => {
    const item = textItem("カレー", 10, 30);
    const result = __test__.recoverClippedTextAffixes([item], [operatorRun("カレー丼", 10)]);

    expect(result.items[0].text).toBe("カレー丼");
    expect(result.recoveredCount).toBe(1);
  });

  it("does not guess when multiple affix expansions fit", () => {
    const item = textItem("身フライ", 20, 40);
    const result = __test__.recoverClippedTextAffixes(
      [item],
      [operatorRun("白身フライ", 10), operatorRun("半身フライ", 10)]
    );

    expect(result.items[0].text).toBe("身フライ");
    expect(result.recoveredCount).toBe(0);
    expect(result.ambiguousCount).toBe(1);
  });

  it("does not rewrite internal differences or long missing affixes", () => {
    const internal = textItem("玉子の", 10, 30);
    const longPrefix = textItem("カレー", 50, 30);
    const result = __test__.recoverClippedTextAffixes(
      [internal, longPrefix],
      [operatorRun("温玉のせ", 10), operatorRun("特製大盛カレー", 10)]
    );

    expect(result.items.map((item) => item.text)).toEqual(["玉子の", "カレー"]);
    expect(result.recoveredCount).toBe(0);
  });

  it("does not recover an affix when the position does not match its glyph advance", () => {
    const item = textItem("身フライ", 35, 40);
    const result = __test__.recoverClippedTextAffixes([item], [operatorRun("白身フライ", 10)]);

    expect(result.items[0].text).toBe("身フライ");
    expect(result.recoveredCount).toBe(0);
  });
});

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
    text,
    fontName: "font-1",
    x,
    y: 100,
    unitScale: 0.01,
    totalUnits: Array.from(text).length * 1000,
    glyphs: Array.from(text).map((character, index) => ({
      text: character,
      startUnits: index * 1000,
      endUnits: (index + 1) * 1000
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
