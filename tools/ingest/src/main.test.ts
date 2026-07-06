import { SOURCE_PAGE_URL } from "@cit-cafeteria/schema";
import { describe, expect, it } from "vitest";
import type { KvWrite } from "./documents";
import { INGEST_USER_AGENT } from "./fetchDiagnostics";
import { type IngestEnv, runIngest } from "./main";

const ENV: IngestEnv = {
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_KV_NAMESPACE_ID: "namespace"
};

describe("ingest runner", () => {
  it("adds diagnostics when source page fetch fails", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const uploads: KvWrite[][] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      throw errorWithCause("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError");
    };

    await expect(
      runIngest({
        env: ENV,
        fetchImpl,
        upload: async (_config, writes) => {
          uploads.push([...writes]);
        },
        now: new Date("2026-07-06T00:00:00.000Z")
      })
    ).rejects.toThrow("No menu documents were generated.");

    expect(calls[0]).toMatchObject({
      url: SOURCE_PAGE_URL,
      init: {
        headers: {
          "user-agent": INGEST_USER_AGENT
        }
      }
    });

    const sourceWrite = uploads[0]?.find((write) => write.key === "source:v1:week:current");
    const sources = JSON.parse(sourceWrite?.value ?? "{}") as {
      warnings?: string[];
      sources?: Array<{ warnings: string[]; status: string }>;
    };

    expect(sources.warnings).toContain("source_discovery_fallback:source_page_fetch_failed_und_err_connect_timeout");
    expect(sources.sources?.map((source) => source.status)).toEqual(["fetch_failed", "fetch_failed", "fetch_failed"]);
    expect(
      sources.sources?.every((source) => source.warnings.includes("pdf_fetch_network_und_err_connect_timeout"))
    ).toBe(true);
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
