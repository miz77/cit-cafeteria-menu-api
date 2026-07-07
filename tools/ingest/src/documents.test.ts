import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateHealthWrites, generateMenuDocuments, generateSourceWrites, generateStaticWrites } from "./documents";
import { failedLocationResult, parseLocationPdf } from "./parser";
import { DEFAULT_PDF_LIMITS, type FetchedPdf, type PdfExtraction } from "./pdf";
import type { IngestSource } from "./sources";

function source(locationId: "tsudanuma" | "shinnarashino-1f" | "shinnarashino-2f"): IngestSource {
  const basename = locationId === "tsudanuma" ? "t.pdf" : locationId === "shinnarashino-1f" ? "s1.pdf" : "s2.pdf";
  return {
    locationId,
    sourcePageUrl: "https://www.cit-s.com/dining/",
    pdfUrl: `https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/${basename}`,
    discovered: true,
    warnings: []
  };
}

function parsed(locationId: "tsudanuma" | "shinnarashino-1f" | "shinnarashino-2f") {
  const ingestSource = source(locationId);
  const pdf: FetchedPdf = {
    source: ingestSource,
    bytes: new Uint8Array([1]),
    fetchedAt: "2026-07-03T00:00:00.000Z",
    sha256: "a".repeat(64),
    warnings: []
  };
  const extraction: PdfExtraction = {
    pageCount: 1,
    warnings: [],
    items: [
      { text: "7月6日（月）", page: 1, x: 100, y: 700, width: 40, height: 10 },
      { text: `${locationId} menu`, page: 1, x: 100, y: 650, width: 40, height: 10 }
    ]
  };
  return parseLocationPdf(pdf, extraction, DEFAULT_PDF_LIMITS, "2026-07-03");
}

function parsedFixture(
  locationId: "tsudanuma" | "shinnarashino-1f" | "shinnarashino-2f",
  fixtureName: string,
  referenceDate: string
) {
  const ingestSource = source(locationId);
  const pdf: FetchedPdf = {
    source: ingestSource,
    bytes: new Uint8Array([1]),
    fetchedAt: "2026-07-03T00:00:00.000Z",
    sha256: "a".repeat(64),
    warnings: []
  };
  const extraction = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", fixtureName), "utf8")) as PdfExtraction;
  return parseLocationPdf(pdf, extraction, DEFAULT_PDF_LIMITS, referenceDate);
}

function documentedOpenApiPaths(): string[] {
  const yaml = readFileSync(new URL("../../../docs/openapi.yaml", import.meta.url), "utf8");
  return Array.from(yaml.matchAll(/^  (\/api\/v1\/[^:]+):$/gm), (match) => match[1]);
}

function documentedOpenApiServerUrls(): string[] {
  const yaml = readFileSync(new URL("../../../docs/openapi.yaml", import.meta.url), "utf8");
  return Array.from(yaml.matchAll(/^  - url: (https:\/\/\S+)$/gm), (match) => match[1]);
}

describe("document generation", () => {
  it("generates all-location and location-specific menu KV writes", () => {
    const generated = generateMenuDocuments(
      [parsed("tsudanuma"), parsed("shinnarashino-1f"), parsed("shinnarashino-2f")],
      "2026-07-03T00:00:00.000Z"
    );

    expect(generated.dates).toEqual(["2026-07-06"]);
    expect(generated.writes.map((write) => write.key)).toEqual([
      "menu:v1:date:2026-07-06:all",
      "menu:v1:date:2026-07-06:location:tsudanuma",
      "menu:v1:date:2026-07-06:location:shinnarashino-1f",
      "menu:v1:date:2026-07-06:location:shinnarashino-2f",
      "menu:v1:week:2026-07-06:all",
      "menu:v1:week:2026-07-06:location:tsudanuma",
      "menu:v1:week:2026-07-06:location:shinnarashino-1f",
      "menu:v1:week:2026-07-06:location:shinnarashino-2f"
    ]);
    expect(generated.writes.every((write) => write.expirationTtl === 3024000)).toBe(true);
  });

  it("keeps failed locations represented in all-location documents", () => {
    const failed = failedLocationResult(source("shinnarashino-2f"), "fetch_failed", "fetch failed");
    const generated = generateMenuDocuments(
      [parsed("tsudanuma"), parsed("shinnarashino-1f"), failed],
      "2026-07-03T00:00:00.000Z"
    );
    const all = JSON.parse(generated.writes[0].value);

    expect(all.locations).toHaveLength(3);
    expect(all.locations[2].status).toBe("fetch_failed");
    expect(all.overallStatus).toBe("partial");
  });

  it("uses closed fallback for missing weekday columns with closed notices", () => {
    const generated = generateMenuDocuments(
      [
        parsed("tsudanuma"),
        parsedFixture("shinnarashino-1f", "shinnarashino-1f-20260706.json", "2026-07-07"),
        parsedFixture("shinnarashino-2f", "shinnarashino-2f-20260706.json", "2026-07-07")
      ],
      "2026-07-07T00:00:00.000Z"
    );

    const saturdayWrite = generated.writes.find((write) => write.key === "menu:v1:date:2026-07-11:all");
    expect(saturdayWrite).toBeDefined();
    const saturday = JSON.parse(saturdayWrite?.value ?? "{}");
    const secondFloor = saturday.locations.find((location: { id: string }) => location.id === "shinnarashino-2f");
    expect(secondFloor.status).toBe("closed");
    expect(secondFloor.statusMessage).toContain("土曜日休業");
  });

  it("generates static, source, and endpoint-ready health writes", () => {
    const staticKeys = generateStaticWrites().map((write) => write.key);
    const sourceKeys = generateSourceWrites("2026-06-29", "2026-07-03T00:00:00.000Z", [parsed("tsudanuma")], []).map(
      (write) => write.key
    );
    const healthKeys = generateHealthWrites({ status: "ok", checkedAt: "2026-07-03T00:00:00.000Z" }).map(
      (write) => write.key
    );

    expect(staticKeys).toEqual(["static:v1:locations", "static:v1:openapi-json"]);
    expect(sourceKeys).toEqual(["source:v1:week:2026-06-29", "source:v1:week:current"]);
    expect(healthKeys).toEqual(["health:v1:current", "health:v1:last-update", "health:v1:last-error"]);
  });

  it("keeps endpoint OpenAPI paths aligned with docs/openapi.yaml", () => {
    const openApiWrite = generateStaticWrites().find((write) => write.key === "static:v1:openapi-json");
    expect(openApiWrite).toBeDefined();
    const openApi = JSON.parse(openApiWrite?.value ?? "{}") as {
      openapi?: string;
      servers?: { url: string }[];
      paths?: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };

    expect(openApi.openapi).toBe("3.1.0");
    expect(openApi.servers?.map((server) => server.url)).toEqual(documentedOpenApiServerUrls());
    expect(Object.keys(openApi.paths ?? {})).toEqual(documentedOpenApiPaths());
    expect(openApi.components?.schemas?.HealthResponse).toBeDefined();
    expect(openApi.components?.schemas?.MenuDocument).toBeDefined();
  });
});
