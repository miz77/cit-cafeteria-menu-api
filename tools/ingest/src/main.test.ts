import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { kvKeys, SOURCE_PAGE_URL } from "@cit-cafeteria/schema";
import { describe, expect, it } from "vitest";
import type { KvWrite } from "./documents";
import { INGEST_USER_AGENT } from "./fetchDiagnostics";
import { CloudflareKvReadError, type CloudflareKvConfig } from "./kv";
import { exitCodeForError, type IngestEnv, IngestRunError, runIngest } from "./main";

const ENV: IngestEnv = {
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_KV_NAMESPACE_ID: "namespace"
};
const TEST_PAUSE_DATE = "2026-08-01";

type ReadKvValue = (config: CloudflareKvConfig, key: string) => Promise<string | null>;

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
        readKvValue: async () => null,
        now: new Date("2026-07-06T00:00:00.000Z")
      })
    ).rejects.toMatchObject({ retryable: true });

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

  it("skips scheduled runs during pause periods before CIT fetch or secrets checks", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("CIT fetch must not be called");
    };

    const result = await runIngest({
      env: {
        GITHUB_EVENT_NAME: "schedule",
        TARGET_DATE: TEST_PAUSE_DATE
      },
      fetchImpl,
      pauseConfigPath: await testPauseConfig()
    });

    expect(result).toMatchObject({ dates: [], writes: [], skipped: "paused" });
  });

  it("does not apply pause skips to manual runs or dry-runs", async () => {
    const manualCalls: string[] = [];
    await expect(
      runIngest({
        env: {
          ...ENV,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          TARGET_DATE: TEST_PAUSE_DATE
        },
        fetchImpl: failingCitFetch(manualCalls),
        readKvValue: async () => null,
        upload: async () => {},
        pauseConfigPath: await testPauseConfig()
      })
    ).rejects.toBeInstanceOf(IngestRunError);
    expect(manualCalls[0]).toBe(SOURCE_PAGE_URL);

    const dryRunCalls: string[] = [];
    const dryRunResult = await runIngest({
      env: {
        DRY_RUN: "true",
        GITHUB_EVENT_NAME: "schedule",
        TARGET_DATE: TEST_PAUSE_DATE
      },
      fetchImpl: failingCitFetch(dryRunCalls),
      pauseConfigPath: await testPauseConfig()
    });
    expect(dryRunResult).not.toHaveProperty("skipped");
    expect(dryRunCalls[0]).toBe(SOURCE_PAGE_URL);
  });

  it("fails malformed pause config even during dry-run", async () => {
    await expect(
      runIngest({
        env: { DRY_RUN: "true" },
        fetchImpl: async () => {
          throw new Error("CIT fetch must not be called");
        },
        pauseConfigPath: await rawPauseConfig("{")
      })
    ).rejects.toMatchObject({ retryable: false });
  });

  it("skips when current-week health and week documents already exist", async () => {
    const result = await runIngest({
      env: ENV,
      fetchImpl: async () => {
        throw new Error("CIT fetch must not be called");
      },
      readKvValue: async (_config, key) => currentWeekKvValue(key),
      now: new Date("2026-07-06T00:00:00.000Z")
    });

    expect(result).toMatchObject({ dates: [], writes: [], skipped: "already_generated" });
  });

  it("does not generated-skip without a current-week week document", async () => {
    const calls: string[] = [];

    await expect(
      runIngest({
        env: ENV,
        fetchImpl: failingCitFetch(calls),
        readKvValue: async (_config, key) => {
          if (key === kvKeys.healthLastUpdate) return currentWeekHealth();
          return null;
        },
        upload: async () => {}
      })
    ).rejects.toMatchObject({ retryable: true });

    expect(calls[0]).toBe(SOURCE_PAGE_URL);
  });

  it("does not generated-skip degraded, stale, malformed, or forced runs", async () => {
    await expectGeneratedSkipMiss(async (_config, key) => {
      if (key === kvKeys.healthLastUpdate) return currentWeekHealth({ status: "degraded" });
      return null;
    });
    await expectGeneratedSkipMiss(async (_config, key) => {
      if (key === kvKeys.healthLastUpdate) return currentWeekHealth({ weekStartDate: "2026-06-29" });
      return null;
    });
    await expectGeneratedSkipMiss(async (_config, key) => {
      if (key === kvKeys.healthLastUpdate) return "{";
      return null;
    });
    await expectGeneratedSkipMiss(async (_config, key) => currentWeekKvValue(key), { FORCE_REFRESH: "true" });
  });

  it("classifies KV read failures before CIT fetch", async () => {
    const authCalls: string[] = [];
    await expect(
      runIngest({
        env: ENV,
        fetchImpl: failingCitFetch(authCalls),
        readKvValue: async () => {
          throw new CloudflareKvReadError("unauthorized", 401);
        }
      })
    ).rejects.toMatchObject({ retryable: false });
    expect(authCalls).toEqual([]);

    const transientCalls: string[] = [];
    await expect(
      runIngest({
        env: ENV,
        fetchImpl: failingCitFetch(transientCalls),
        readKvValue: async () => {
          throw new CloudflareKvReadError("rate limited", 429);
        }
      })
    ).rejects.toMatchObject({ retryable: true });
    expect(transientCalls).toEqual([]);
  });

  it("classifies all-location parse failures as non-retryable", async () => {
    const uploads: KvWrite[][] = [];

    await expect(
      runIngest({
        env: ENV,
        fetchImpl: invalidPdfFetch,
        upload: async (_config, writes) => {
          uploads.push([...writes]);
        },
        readKvValue: async () => null
      })
    ).rejects.toMatchObject({ retryable: false });

    const healthWrite = uploads[0]?.find((write) => write.key === kvKeys.healthCurrent);
    expect(JSON.parse(healthWrite?.value ?? "{}")).toMatchObject({ status: "failed" });
  });

  it("classifies source discovery network failures as retryable even when fallback PDFs parse-fail", async () => {
    await expect(
      runIngest({
        env: ENV,
        fetchImpl: sourcePageFailureThenInvalidPdfFetch,
        upload: async () => {},
        readKvValue: async () => null
      })
    ).rejects.toMatchObject({ retryable: true });
  });

  it("classifies upload failures as retryable", async () => {
    await expect(
      runIngest({
        env: ENV,
        fetchImpl: invalidPdfFetch,
        readKvValue: async () => null,
        upload: async () => {
          throw new Error("upload unavailable");
        }
      })
    ).rejects.toMatchObject({ retryable: true });
  });

  it("maps ingest errors to CLI exit codes", () => {
    expect(exitCodeForError(new IngestRunError("retry", true))).toBe(10);
    expect(exitCodeForError(new IngestRunError("stop", false))).toBe(20);
    expect(exitCodeForError(new Error("unknown"))).toBe(10);
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

function failingCitFetch(calls: string[]): typeof fetch {
  return async (input) => {
    calls.push(String(input));
    throw errorWithCause("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError");
  };
}

const invalidPdfFetch: typeof fetch = async (input) => {
  if (String(input) === SOURCE_PAGE_URL) {
    return new Response("<html></html>", { status: 200 });
  }

  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
};

const sourcePageFailureThenInvalidPdfFetch: typeof fetch = async (input) => {
  if (String(input) === SOURCE_PAGE_URL) {
    throw errorWithCause("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError");
  }

  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
};

async function expectGeneratedSkipMiss(readKvValue: ReadKvValue, env: Partial<IngestEnv> = {}): Promise<void> {
  const calls: string[] = [];
  await expect(
    runIngest({
      env: { ...ENV, ...env },
      fetchImpl: failingCitFetch(calls),
      readKvValue,
      upload: async () => {}
    })
  ).rejects.toBeInstanceOf(IngestRunError);
  expect(calls[0]).toBe(SOURCE_PAGE_URL);
}

function currentWeekKvValue(key: string): string | null {
  if (key === kvKeys.healthLastUpdate) return currentWeekHealth();
  if (key === kvKeys.menuWeekAll("2026-07-06")) {
    return JSON.stringify({ documentKind: "week", weekStartDate: "2026-07-06" });
  }
  return null;
}

function currentWeekHealth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "ok",
    checkedAt: "2026-07-06T00:00:00.000Z",
    generatedAt: "2026-07-06T00:00:00.000Z",
    weekStartDate: "2026-07-06",
    ...overrides
  });
}

async function pauseConfig(periods: Array<{ from: string; to: string; reason: string }>): Promise<string> {
  return rawPauseConfig(JSON.stringify({ pausePeriods: periods }));
}

async function testPauseConfig(): Promise<string> {
  return pauseConfig([{ from: TEST_PAUSE_DATE, to: TEST_PAUSE_DATE, reason: "test" }]);
}

async function rawPauseConfig(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cit-cafeteria-main-"));
  const file = path.join(dir, "pauses.json");
  await writeFile(file, value);
  return file;
}
