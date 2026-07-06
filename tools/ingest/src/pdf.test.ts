import { describe, expect, it } from "vitest";
import { INGEST_USER_AGENT } from "./fetchDiagnostics";
import { DEFAULT_PDF_LIMITS, fetchPdf, PdfFetchError } from "./pdf";
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

function errorWithCause(code: string, name: string): Error {
  const error = new TypeError("fetch failed");
  const cause = new Error(`network cause ${code}`) as Error & { code: string };
  cause.name = name;
  cause.code = code;
  Object.defineProperty(error, "cause", { value: cause });
  return error;
}
