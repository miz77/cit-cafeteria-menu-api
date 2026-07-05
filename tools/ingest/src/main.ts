import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type HealthResponse, SOURCE_PAGE_URL } from "@cit-cafeteria/schema";
import { dateInAsiaTokyo, mondayWeekStart, parseDateOnly } from "./dates";
import {
  generateHealthWrites,
  generateMenuDocuments,
  generateSourceWrites,
  generateStaticWrites,
  type KvWrite
} from "./documents";
import { type CloudflareKvConfig, uploadKvWrites } from "./kv";
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
}

export interface RunIngestOptions {
  env?: IngestEnv;
  fetchImpl?: typeof fetch;
  upload?: (config: CloudflareKvConfig, writes: readonly KvWrite[]) => Promise<void>;
  now?: Date;
}

export async function runIngest(options: RunIngestOptions = {}): Promise<{ writes: KvWrite[]; dates: string[] }> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const targetDate = env.TARGET_DATE ? normalizeTargetDate(env.TARGET_DATE) : dateInAsiaTokyo(now);
  const weekStartDate = mondayWeekStart(targetDate);
  const generatedAt = now.toISOString();
  const limits = limitsFromEnv(env);

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

  if (env.DRY_RUN === "true") {
    if (env.DRY_RUN_OUTPUT_DIR) {
      await writeDryRunFiles(env.DRY_RUN_OUTPUT_DIR, writes);
    }
    for (const write of writes) {
      console.log(`${write.key}${write.expirationTtl ? ` ttl=${write.expirationTtl}` : ""}`);
    }
    return { writes, dates: generated.dates };
  }

  const config = cloudflareConfigFromEnv(env);
  const upload = options.upload ?? uploadKvWrites;
  await upload(config, writes);

  if (generated.dates.length === 0) {
    throw new Error("No menu documents were generated.");
  }

  return { writes, dates: generated.dates };
}

async function discoverSources(fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(SOURCE_PAGE_URL);
    if (!response.ok) return fallbackSources(`source_page_http_${response.status}`);
    return discoverSourcesFromHtml(await response.text(), SOURCE_PAGE_URL);
  } catch (error) {
    return fallbackSources(`source_page_fetch_failed_${error instanceof Error ? error.name : "unknown"}`);
  }
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

  if (!accountId) throw new Error("Missing required environment variable: CLOUDFLARE_ACCOUNT_ID");
  if (!apiToken) throw new Error("Missing required environment variable: CLOUDFLARE_API_TOKEN");
  if (!namespaceId) throw new Error("Missing required environment variable: CLOUDFLARE_KV_NAMESPACE_ID");

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
    process.exitCode = 1;
  });
}
