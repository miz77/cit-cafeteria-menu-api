import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type HealthResponse, kvKeys, type LocationStatus, SOURCE_PAGE_URL } from "@cit-cafeteria/schema";
import { dateInAsiaTokyo, mondayWeekStart, parseDateOnly } from "./dates";
import {
  generateHealthWrites,
  generateMenuDocuments,
  generateSourceWrites,
  generateStaticWrites,
  type KvWrite
} from "./documents";
import { fetchFailureSlug, INGEST_USER_AGENT, logFetchFailure } from "./fetchDiagnostics";
import { CloudflareKvReadError, getKvValue, type CloudflareKvConfig, uploadKvWrites } from "./kv";
import { isPausedOn, loadPausePeriods } from "./pauses";
import { failedLocationResult, type LocationParseResult, parseLocationPdf } from "./parser";
import { DEFAULT_PDF_LIMITS, extractTextItemsFromPdf, fetchPdf, PdfFetchError, type PdfLimits } from "./pdf";
import { discoverSourcesFromHtml, fallbackSources, type IngestSource } from "./sources";

export interface IngestEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_KV_NAMESPACE_ID?: string;
  TARGET_DATE?: string;
  MAX_SOURCE_PDF_BYTES?: string;
  HARD_MAX_SOURCE_PDF_BYTES?: string;
  EXPECTED_PAGES_PER_PDF?: string;
  MAX_PAGES_PER_PDF?: string;
  MAX_TEXT_ITEMS_PER_PDF?: string;
  MAX_RAW_TEXT_CHARS_PER_LOCATION_PER_DATE?: string;
  DRY_RUN?: string;
  DRY_RUN_OUTPUT_DIR?: string;
  GITHUB_STEP_SUMMARY?: string;
  GITHUB_EVENT_NAME?: string;
  FORCE_REFRESH?: string;
}

export type IngestSkippedReason = "paused" | "already_generated";

export interface RunIngestResult {
  writes: KvWrite[];
  dates: string[];
  skipped?: IngestSkippedReason;
}

export interface RunIngestOptions {
  env?: IngestEnv;
  fetchImpl?: typeof fetch;
  upload?: (config: CloudflareKvConfig, writes: readonly KvWrite[]) => Promise<void>;
  readKvValue?: (config: CloudflareKvConfig, key: string) => Promise<string | null>;
  pauseConfigPath?: string;
  now?: Date;
}

export class IngestRunError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof IngestRunError) return error.retryable ? 10 : 20;
  return 10;
}

export async function runIngest(options: RunIngestOptions = {}): Promise<RunIngestResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const targetDate = env.TARGET_DATE ? normalizeTargetDate(env.TARGET_DATE) : dateInAsiaTokyo(now);
  const weekStartDate = mondayWeekStart(targetDate);
  const generatedAt = now.toISOString();
  const limits = limitsFromEnv(env);
  const isDryRun = env.DRY_RUN === "true";

  let pausePeriods: Awaited<ReturnType<typeof loadPausePeriods>>;
  try {
    pausePeriods = await loadPausePeriods(options.pauseConfigPath);
  } catch (error) {
    throw new IngestRunError(`Invalid pause config: ${errorMessage(error)}`, false);
  }

  const pause = isPausedOn(targetDate, pausePeriods);
  if (!isDryRun && env.GITHUB_EVENT_NAME === "schedule" && pause) {
    await reportSkipSummary({
      reason: "paused",
      targetDate,
      weekStartDate,
      stepSummaryPath: env.GITHUB_STEP_SUMMARY,
      detail: `Pause period ${pause.reason} is active from ${pause.from} to ${pause.to}.`
    });
    return { writes: [], dates: [], skipped: "paused" };
  }

  let config: CloudflareKvConfig | null = null;
  if (!isDryRun) {
    config = cloudflareConfigFromEnv(env);
    const readKvValue = options.readKvValue ?? ((readConfig, key) => getKvValue(readConfig, key, fetchImpl));
    const generatedSkip = await alreadyGeneratedSkip(config, weekStartDate, readKvValue, env.FORCE_REFRESH === "true");
    if (generatedSkip) {
      await reportSkipSummary({
        reason: "already_generated",
        targetDate,
        weekStartDate,
        stepSummaryPath: env.GITHUB_STEP_SUMMARY,
        detail: `Week ${weekStartDate} was already generated at ${generatedSkip.generatedAt}.`
      });
      return { writes: [], dates: [], skipped: "already_generated" };
    }
  }

  const discovery = await discoverSources(fetchImpl);
  const results: LocationParseResult[] = [];

  for (const source of discovery.sources) {
    results.push(await ingestLocation(source, limits, targetDate, fetchImpl));
  }

  const generated = generateMenuDocuments(results, generatedAt);
  const health: HealthResponse = {
    status:
      generated.dates.length === 0 ? "failed" : results.some((result) => result.status !== "ok") ? "degraded" : "ok",
    checkedAt: generatedAt,
    generatedAt,
    weekStartDate,
    lastError: generated.dates.length === 0 ? "No menu documents were generated." : null
  };

  await reportIngestSummary({
    targetDate,
    weekStartDate,
    generatedAt,
    dates: generated.dates,
    discoveryWarnings: discovery.warnings,
    health,
    results,
    stepSummaryPath: env.GITHUB_STEP_SUMMARY
  });

  const writes = [
    ...generated.writes,
    ...generateStaticWrites(),
    ...generateSourceWrites(weekStartDate, generatedAt, results, discovery.warnings),
    ...generateHealthWrites(health)
  ];

  if (isDryRun) {
    if (env.DRY_RUN_OUTPUT_DIR) {
      await writeDryRunFiles(env.DRY_RUN_OUTPUT_DIR, writes);
    }
    for (const write of writes) {
      console.log(`${write.key}${write.expirationTtl ? ` ttl=${write.expirationTtl}` : ""}`);
    }
    return { writes, dates: generated.dates };
  }

  const upload = options.upload ?? uploadKvWrites;
  try {
    if (!config) throw new IngestRunError("Cloudflare config was not initialized.", false);
    await upload(config, writes);
  } catch (error) {
    if (error instanceof IngestRunError) throw error;
    throw new IngestRunError(`KV upload failed: ${errorMessage(error)}`, true);
  }

  if (generated.dates.length === 0) {
    throw classifyEmptyRun(results, discovery.warnings);
  }

  return { writes, dates: generated.dates };
}

async function discoverSources(fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(SOURCE_PAGE_URL, {
      headers: {
        "user-agent": INGEST_USER_AGENT
      }
    });
    if (!response.ok) return fallbackSources(`source_page_http_${response.status}`);
    return discoverSourcesFromHtml(await response.text(), SOURCE_PAGE_URL);
  } catch (error) {
    const details = logFetchFailure("source_page", SOURCE_PAGE_URL, error);
    return fallbackSources(`source_page_fetch_failed_${fetchFailureSlug(details)}`);
  }
}

interface AlreadyGeneratedSkip {
  generatedAt: string;
}

async function alreadyGeneratedSkip(
  config: CloudflareKvConfig,
  weekStartDate: string,
  readKvValue: (config: CloudflareKvConfig, key: string) => Promise<string | null>,
  forceRefresh: boolean
): Promise<AlreadyGeneratedSkip | null> {
  if (forceRefresh) return null;

  const healthValue = await readKvForSkip(config, kvKeys.healthLastUpdate, readKvValue);
  if (!healthValue) return null;

  const health = parseHealthForSkip(healthValue);
  if (!health) return null;
  if (health.weekStartDate !== weekStartDate || health.status !== "ok") return null;

  const weekValue = await readKvForSkip(config, kvKeys.menuWeekAll(weekStartDate), readKvValue);
  if (!weekValue) return null;

  const week = parseWeekForSkip(weekValue);
  if (!week || week.weekStartDate !== weekStartDate) return null;

  return {
    generatedAt: health.generatedAt ?? health.checkedAt
  };
}

async function readKvForSkip(
  config: CloudflareKvConfig,
  key: string,
  readKvValue: (config: CloudflareKvConfig, key: string) => Promise<string | null>
): Promise<string | null> {
  try {
    return await readKvValue(config, key);
  } catch (error) {
    throw classifyKvReadError(error);
  }
}

function parseHealthForSkip(value: string): HealthResponse | null {
  try {
    const parsed = JSON.parse(value) as Partial<HealthResponse>;
    if (typeof parsed.status !== "string" || typeof parsed.checkedAt !== "string") {
      console.warn("Stored health document is malformed; running ingest.");
      return null;
    }
    return parsed as HealthResponse;
  } catch (error) {
    console.warn(`Stored health document is not valid JSON; running ingest: ${errorMessage(error)}`);
    return null;
  }
}

function parseWeekForSkip(value: string): { weekStartDate?: string } | null {
  try {
    const parsed = JSON.parse(value) as { weekStartDate?: unknown };
    if (typeof parsed.weekStartDate !== "string") {
      console.warn("Stored week menu document is malformed; running ingest.");
      return null;
    }
    return { weekStartDate: parsed.weekStartDate };
  } catch (error) {
    console.warn(`Stored week menu document is not valid JSON; running ingest: ${errorMessage(error)}`);
    return null;
  }
}

function classifyKvReadError(error: unknown): IngestRunError {
  if (error instanceof CloudflareKvReadError) {
    if (error.status === 401 || error.status === 403) {
      return new IngestRunError(error.message, false);
    }
    if (error.status === null || error.status === 429 || (error.status >= 500 && error.status <= 599)) {
      return new IngestRunError(error.message, true);
    }
    return new IngestRunError(error.message, false);
  }

  return new IngestRunError(`KV read failed: ${errorMessage(error)}`, true);
}

async function ingestLocation(
  source: IngestSource,
  limits: PdfLimits,
  targetDate: string,
  fetchImpl: typeof fetch
): Promise<LocationParseResult> {
  try {
    const pdf = await fetchPdf(source, limits, fetchImpl);
    const extraction = await extractTextItemsFromPdf(pdf.bytes);
    return parseLocationPdf(pdf, extraction, limits, targetDate);
  } catch (error) {
    if (error instanceof PdfFetchError) {
      return failedLocationResult(source, error.status, error.message, error.warnings);
    }
    return failedLocationResult(
      source,
      "parse_failed",
      error instanceof Error ? error.message : "Unknown parse failure"
    );
  }
}

function limitsFromEnv(env: IngestEnv): PdfLimits {
  return {
    ...DEFAULT_PDF_LIMITS,
    maxSourcePdfBytes: numberEnv(env.MAX_SOURCE_PDF_BYTES, DEFAULT_PDF_LIMITS.maxSourcePdfBytes),
    hardMaxSourcePdfBytes: numberEnv(env.HARD_MAX_SOURCE_PDF_BYTES, DEFAULT_PDF_LIMITS.hardMaxSourcePdfBytes),
    expectedPagesPerPdf: numberEnv(env.EXPECTED_PAGES_PER_PDF, DEFAULT_PDF_LIMITS.expectedPagesPerPdf),
    maxPagesPerPdf: numberEnv(env.MAX_PAGES_PER_PDF, DEFAULT_PDF_LIMITS.maxPagesPerPdf),
    maxTextItemsPerPdf: numberEnv(env.MAX_TEXT_ITEMS_PER_PDF, DEFAULT_PDF_LIMITS.maxTextItemsPerPdf),
    maxRawTextCharsPerLocationPerDate: numberEnv(
      env.MAX_RAW_TEXT_CHARS_PER_LOCATION_PER_DATE,
      DEFAULT_PDF_LIMITS.maxRawTextCharsPerLocationPerDate
    )
  };
}

function cloudflareConfigFromEnv(env: IngestEnv): CloudflareKvConfig {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const namespaceId = env.CLOUDFLARE_KV_NAMESPACE_ID;

  if (!accountId) throw new IngestRunError("Missing required environment variable: CLOUDFLARE_ACCOUNT_ID", false);
  if (!apiToken) throw new IngestRunError("Missing required environment variable: CLOUDFLARE_API_TOKEN", false);
  if (!namespaceId) {
    throw new IngestRunError("Missing required environment variable: CLOUDFLARE_KV_NAMESPACE_ID", false);
  }

  return { accountId, apiToken, namespaceId };
}

function normalizeTargetDate(value: string): string {
  return parseDateOnly(value).toISOString().slice(0, 10);
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const DETERMINISTIC_EMPTY_STATUSES = new Set<LocationStatus>(["parse_failed", "source_changed", "source_too_large"]);

function classifyEmptyRun(
  results: readonly LocationParseResult[],
  discoveryWarnings: readonly string[]
): IngestRunError {
  if (hasRetryableDiscoveryFailure(discoveryWarnings)) {
    return new IngestRunError("No menu documents were generated after a retryable source discovery failure.", true);
  }

  if (results.some((result) => result.status === "fetch_failed")) {
    return new IngestRunError("No menu documents were generated; at least one location fetch failed.", true);
  }

  if (results.length > 0 && results.every((result) => DETERMINISTIC_EMPTY_STATUSES.has(result.status))) {
    return new IngestRunError("No menu documents were generated due to deterministic source or parse failures.", false);
  }

  return new IngestRunError("No menu documents were generated.", true);
}

function hasRetryableDiscoveryFailure(warnings: readonly string[]): boolean {
  return warnings.some(
    (warning) =>
      warning.startsWith("source_discovery_fallback:source_page_fetch_failed_") ||
      warning === "source_discovery_fallback:source_page_http_429" ||
      /^source_discovery_fallback:source_page_http_5\d\d$/.test(warning)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SkipSummary {
  reason: IngestSkippedReason;
  targetDate: string;
  weekStartDate: string;
  detail: string;
  stepSummaryPath?: string;
}

async function reportSkipSummary(summary: SkipSummary): Promise<void> {
  const text = skipSummaryText(summary);
  console.log(text.trimEnd());

  if (!summary.stepSummaryPath) return;
  try {
    await appendFile(summary.stepSummaryPath, text);
  } catch (error) {
    console.warn(`Could not write GitHub step summary: ${errorMessage(error)}`);
  }
}

function skipSummaryText(summary: SkipSummary): string {
  const reasonLabel = summary.reason === "paused" ? "pause period" : "already generated";
  return [
    "## Cafeteria Ingest Skipped",
    "",
    `- Reason: \`${reasonLabel}\``,
    `- Target date: \`${summary.targetDate}\``,
    `- Week start: \`${summary.weekStartDate}\``,
    `- Detail: ${summary.detail}`,
    ""
  ].join("\n");
}

interface IngestSummary {
  targetDate: string;
  weekStartDate: string;
  generatedAt: string;
  dates: readonly string[];
  discoveryWarnings: readonly string[];
  health: HealthResponse;
  results: readonly LocationParseResult[];
  stepSummaryPath?: string;
}

async function reportIngestSummary(summary: IngestSummary): Promise<void> {
  logIngestSummary(summary);

  if (!summary.stepSummaryPath) return;
  try {
    await appendFile(summary.stepSummaryPath, githubStepSummary(summary));
  } catch (error) {
    console.warn(`Could not write GitHub step summary: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function logIngestSummary(summary: IngestSummary): void {
  console.log(
    [
      "Ingest summary:",
      `targetDate=${summary.targetDate}`,
      `weekStartDate=${summary.weekStartDate}`,
      `health=${summary.health.status}`,
      `generatedDates=${summary.dates.length}`,
      `generatedAt=${summary.generatedAt}`
    ].join(" ")
  );

  if (summary.discoveryWarnings.length > 0) {
    console.log(`Source discovery warnings: ${summary.discoveryWarnings.join(", ")}`);
  }

  for (const result of summary.results) {
    console.log(
      [
        `Location ${result.locationId}:`,
        `status=${result.status}`,
        `dates=${result.menusByDate.size}`,
        `warnings=${result.warnings.length > 0 ? result.warnings.join(",") : "none"}`,
        `message=${JSON.stringify(result.statusMessage)}`
      ].join(" ")
    );
  }
}

function githubStepSummary(summary: IngestSummary): string {
  const lines = [
    "## Cafeteria Ingest Summary",
    "",
    `- Target date: \`${summary.targetDate}\``,
    `- Week start: \`${summary.weekStartDate}\``,
    `- Health: \`${summary.health.status}\``,
    `- Generated dates: \`${summary.dates.length}\``,
    `- Generated at: \`${summary.generatedAt}\``,
    ""
  ];

  if (summary.discoveryWarnings.length > 0) {
    lines.push(`- Source discovery warnings: \`${summary.discoveryWarnings.join(", ")}\``, "");
  }

  lines.push("| Location | Status | Dates | Warnings | Message |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const result of summary.results) {
    lines.push(
      `| ${[
        markdownTableCell(result.locationId),
        markdownTableCell(result.status),
        String(result.menusByDate.size),
        markdownTableCell(result.warnings.length > 0 ? result.warnings.join(", ") : "none"),
        markdownTableCell(result.statusMessage)
      ].join(" | ")} |`
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function markdownTableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function writeDryRunFiles(outputDir: string, writes: readonly KvWrite[]): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(
      writes.map((write) => ({
        key: write.key,
        file: fileNameForKey(write.key),
        expirationTtl: write.expirationTtl ?? null
      })),
      null,
      2
    )}\n`
  );

  for (const write of writes) {
    await writeFile(path.join(outputDir, fileNameForKey(write.key)), write.value);
  }
}

function fileNameForKey(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]+/g, "__")}.json`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngest().catch((error) => {
    console.error(error);
    process.exitCode = exitCodeForError(error);
  });
}
