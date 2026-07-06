import {
  assertMenuDocument,
  computeOverallStatus,
  DATA_NOTICE,
  type HealthResponse,
  HISTORY_TTL_SECONDS,
  kvKeys,
  LOCATIONS,
  type LocationId,
  type LocationMenuDocument,
  type LocationMenuWeekDocument,
  type LocationsResponse,
  type MenuDocument,
  type MenuWeekDay,
  type MenuWeekDocument,
  PROJECT_NOTICE,
  SCHEMA_VERSION,
  type SourcesResponse,
  TIMEZONE,
  UNOFFICIAL_NOTICE
} from "@cit-cafeteria/schema";
import { mondayWeekStart } from "./dates";
import type { LocationParseResult } from "./parser";
import { fallbackLocationMenu } from "./parser";

export interface KvWrite {
  key: string;
  value: string;
  expirationTtl?: number;
}

export interface GeneratedDocuments {
  dates: string[];
  writes: KvWrite[];
}

export function generateMenuDocuments(
  results: readonly LocationParseResult[],
  generatedAt: string
): GeneratedDocuments {
  const dates = Array.from(new Set(results.flatMap((result) => Array.from(result.menusByDate.keys())))).sort();
  const writes: KvWrite[] = [];
  const generatedDays: MenuWeekDay[] = [];

  for (const date of dates) {
    const locations = locationsForDate(results, date);
    const warnings = locations.flatMap((location) => location.parser.warnings);
    generatedDays.push({
      date,
      overallStatus: computeOverallStatus(locations),
      locations,
      warnings
    });

    const allDocument: MenuDocument = {
      schemaVersion: SCHEMA_VERSION,
      documentKind: "all-locations",
      date,
      timezone: TIMEZONE,
      generatedAt,
      overallStatus: computeOverallStatus(locations),
      locations,
      warnings,
      notice: UNOFFICIAL_NOTICE,
      project: PROJECT_NOTICE,
      dataNotice: DATA_NOTICE
    };

    assertMenuDocument(allDocument);
    writes.push({
      key: kvKeys.menuAll(date),
      value: stableJson(allDocument),
      expirationTtl: HISTORY_TTL_SECONDS
    });

    for (const location of locations) {
      const locationDocument: LocationMenuDocument = {
        schemaVersion: SCHEMA_VERSION,
        documentKind: "single-location",
        date,
        timezone: TIMEZONE,
        generatedAt,
        location,
        warnings: location.parser.warnings,
        notice: UNOFFICIAL_NOTICE,
        project: PROJECT_NOTICE,
        dataNotice: DATA_NOTICE
      };

      assertMenuDocument(locationDocument);
      writes.push({
        key: kvKeys.menuLocation(date, location.id),
        value: stableJson(locationDocument),
        expirationTtl: HISTORY_TTL_SECONDS
      });
    }
  }

  writes.push(...generateWeekMenuWrites(generatedDays, generatedAt));

  return { dates, writes };
}

export function generateStaticWrites(): KvWrite[] {
  const locationsResponse: LocationsResponse = {
    locations: [...LOCATIONS]
  };

  return [
    {
      key: kvKeys.locations,
      value: stableJson(locationsResponse)
    },
    {
      key: kvKeys.openapiJson,
      value: stableJson(openApiJson())
    }
  ];
}

export function generateSourceWrites(
  weekStartDate: string,
  generatedAt: string,
  results: readonly LocationParseResult[],
  warnings: readonly string[]
): KvWrite[] {
  const response: SourcesResponse = {
    weekStartDate,
    generatedAt,
    warnings: [...warnings],
    sources: results.map((result) => ({
      locationId: result.locationId,
      sourcePageUrl: result.sourceInfo.sourcePageUrl,
      pdfUrl: result.sourceInfo.pdfUrl,
      fetchedAt: result.sourceInfo.fetchedAt,
      sha256: result.sourceInfo.sha256,
      status: result.status,
      warnings: result.warnings
    }))
  };

  const value = stableJson(response);
  return [
    {
      key: kvKeys.sourceWeek(weekStartDate),
      value,
      expirationTtl: HISTORY_TTL_SECONDS
    },
    {
      key: kvKeys.sourceCurrent,
      value
    }
  ];
}

export function generateHealthWrites(health: HealthResponse): KvWrite[] {
  const current = stableJson(health);
  return [
    {
      key: kvKeys.healthCurrent,
      value: current
    },
    {
      key: kvKeys.healthLastUpdate,
      value: current
    },
    {
      key: kvKeys.healthLastError,
      value: stableJson({ lastError: health.lastError ?? null, checkedAt: health.checkedAt })
    }
  ];
}

function resultForLocation(results: readonly LocationParseResult[], locationId: LocationId): LocationParseResult {
  const result = results.find((candidate) => candidate.locationId === locationId);
  if (!result) throw new Error(`Missing parse result for ${locationId}`);
  return result;
}

function locationsForDate(results: readonly LocationParseResult[], date: string) {
  return LOCATIONS.map((location) => {
    const result = resultForLocation(results, location.id);
    return result.menusByDate.get(date) ?? fallbackLocationMenu(result, date);
  });
}

function generateWeekMenuWrites(days: readonly MenuWeekDay[], generatedAt: string): KvWrite[] {
  const writes: KvWrite[] = [];
  const weekStartDates = Array.from(new Set(days.map((day) => mondayWeekStart(day.date)))).sort();

  for (const weekStartDate of weekStartDates) {
    const weekDays = days.filter((day) => mondayWeekStart(day.date) === weekStartDate);
    const warnings = weekDays.flatMap((day) => day.warnings);
    const allDocument: MenuWeekDocument = {
      schemaVersion: SCHEMA_VERSION,
      documentKind: "week",
      scope: "all-locations",
      weekStartDate,
      timezone: TIMEZONE,
      generatedAt,
      overallStatus: computeOverallStatus(weekDays.flatMap((day) => day.locations)),
      days: weekDays,
      warnings,
      notice: UNOFFICIAL_NOTICE,
      project: PROJECT_NOTICE,
      dataNotice: DATA_NOTICE
    };

    assertMenuDocument(allDocument);
    writes.push({
      key: kvKeys.menuWeekAll(weekStartDate),
      value: stableJson(allDocument),
      expirationTtl: HISTORY_TTL_SECONDS
    });

    for (const location of LOCATIONS) {
      const locationDays = weekDays.map((day) => {
        const locationMenu = day.locations.find((candidate) => candidate.id === location.id);
        if (!locationMenu) throw new Error(`Missing ${location.id} in week ${weekStartDate} day ${day.date}`);
        return {
          date: day.date,
          location: locationMenu,
          warnings: locationMenu.parser.warnings
        };
      });
      const locationDocument: LocationMenuWeekDocument = {
        schemaVersion: SCHEMA_VERSION,
        documentKind: "week",
        scope: "single-location",
        weekStartDate,
        timezone: TIMEZONE,
        generatedAt,
        location,
        days: locationDays,
        warnings: locationDays.flatMap((day) => day.warnings),
        notice: UNOFFICIAL_NOTICE,
        project: PROJECT_NOTICE,
        dataNotice: DATA_NOTICE
      };

      assertMenuDocument(locationDocument);
      writes.push({
        key: kvKeys.menuWeek(weekStartDate, location.id),
        value: stableJson(locationDocument),
        expirationTtl: HISTORY_TTL_SECONDS
      });
    }
  }

  return writes;
}

function openApiJson(): Record<string, unknown> {
  const apiBaseUrl = "https://cit-cafeteria-menu-api.miz77.workers.dev";
  const menuSchemaUrl =
    "https://raw.githubusercontent.com/miz77/cit-cafeteria-menu-api/main/docs/schemas/menu.schema.json";
  const menuSchema = (name: string) => ({ $ref: `${menuSchemaUrl}#/$defs/${name}` });
  const json = (schema: Record<string, unknown>) => ({
    content: {
      "application/json": {
        schema
      }
    }
  });
  const problem = { $ref: "#/components/responses/Problem" };

  return {
    openapi: "3.1.0",
    info: {
      title: "CIT Cafeteria Menu API",
      version: "1.0.0-beta",
      summary: "千葉工業大学の学食メニューを返す非公式 JSON API。",
      description: "CITサービスが公開している学食メニュー PDF から生成した非公式 JSON API です。正確性は保証しません。",
      license: { name: "MIT" }
    },
    servers: [{ url: apiBaseUrl }],
    tags: [{ name: "locations" }, { name: "menus" }, { name: "sources" }, { name: "health" }],
    components: {
      parameters: {
        Date: {
          name: "date",
          in: "path",
          required: true,
          description: "日付。`YYYY-MM-DD` 形式で指定します。",
          schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          example: "2026-07-06"
        },
        LocationId: {
          name: "locationId",
          in: "path",
          required: true,
          schema: { $ref: "#/components/schemas/LocationId" }
        }
      },
      responses: {
        Problem: {
          description: "Problem Details エラー",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/Problem" }
            }
          }
        }
      },
      schemas: {
        LocationId: {
          type: "string",
          enum: ["tsudanuma", "shinnarashino-1f", "shinnarashino-2f"]
        },
        Location: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "campus", "floor"],
          properties: {
            id: { $ref: "#/components/schemas/LocationId" },
            name: { type: "string" },
            campus: { type: "string" },
            floor: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        },
        LocationsResponse: {
          type: "object",
          additionalProperties: false,
          required: ["locations"],
          properties: {
            locations: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: { $ref: "#/components/schemas/Location" }
            }
          }
        },
        MenuDocument: menuSchema("MenuDocument"),
        LocationMenuDocument: menuSchema("LocationMenuDocument"),
        MenuWeekDocument: menuSchema("MenuWeekDocument"),
        LocationMenuWeekDocument: menuSchema("LocationMenuWeekDocument"),
        SourcesResponse: {
          type: "object",
          additionalProperties: false,
          required: ["weekStartDate", "generatedAt", "sources", "warnings"],
          properties: {
            weekStartDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            generatedAt: { type: "string", format: "date-time" },
            sources: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["locationId", "sourcePageUrl", "pdfUrl"],
                properties: {
                  locationId: { $ref: "#/components/schemas/LocationId" },
                  sourcePageUrl: { type: "string", format: "uri" },
                  pdfUrl: { type: "string", format: "uri" },
                  fetchedAt: { type: "string", format: "date-time" },
                  sha256: { type: "string" },
                  status: { type: "string" },
                  warnings: { type: "array", items: { type: "string" } }
                }
              }
            },
            warnings: { type: "array", items: { type: "string" } }
          }
        },
        HealthResponse: {
          type: "object",
          additionalProperties: false,
          required: ["status", "checkedAt"],
          properties: {
            status: { type: "string", enum: ["ok", "degraded", "failed", "unknown"] },
            checkedAt: { type: "string", format: "date-time" },
            weekStartDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            generatedAt: { type: "string", format: "date-time" },
            lastError: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        },
        Problem: {
          type: "object",
          additionalProperties: true,
          required: ["type", "title", "status"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string" }
          }
        }
      }
    },
    paths: {
      "/api/v1/locations": {
        get: {
          tags: ["locations"],
          summary: "食堂一覧",
          responses: {
            "200": { description: "食堂一覧", ...json({ $ref: "#/components/schemas/LocationsResponse" }) },
            "404": problem
          }
        }
      },
      "/api/v1/menus/today": {
        get: {
          tags: ["menus"],
          summary: "今日の全食堂メニュー",
          responses: {
            "200": {
              description: "全食堂の日次メニュー",
              ...json({ $ref: "#/components/schemas/MenuDocument" })
            },
            "404": problem
          }
        }
      },
      "/api/v1/menus/week": {
        get: {
          tags: ["menus"],
          summary: "今週の全食堂メニュー",
          responses: {
            "200": {
              description: "全食堂の週次メニュー",
              ...json({ $ref: "#/components/schemas/MenuWeekDocument" })
            },
            "404": problem
          }
        }
      },
      "/api/v1/menus/{date}": {
        get: {
          tags: ["menus"],
          summary: "指定日の全食堂メニュー",
          parameters: [{ $ref: "#/components/parameters/Date" }],
          responses: {
            "200": {
              description: "全食堂の日次メニュー",
              ...json({ $ref: "#/components/schemas/MenuDocument" })
            },
            "400": problem,
            "404": problem
          }
        }
      },
      "/api/v1/locations/{locationId}/menus/today": {
        get: {
          tags: ["menus"],
          summary: "今日の指定食堂メニュー",
          parameters: [{ $ref: "#/components/parameters/LocationId" }],
          responses: {
            "200": {
              description: "指定食堂の日次メニュー",
              ...json({ $ref: "#/components/schemas/LocationMenuDocument" })
            },
            "404": problem
          }
        }
      },
      "/api/v1/locations/{locationId}/menus/week": {
        get: {
          tags: ["menus"],
          summary: "今週の指定食堂メニュー",
          parameters: [{ $ref: "#/components/parameters/LocationId" }],
          responses: {
            "200": {
              description: "指定食堂の週次メニュー",
              ...json({ $ref: "#/components/schemas/LocationMenuWeekDocument" })
            },
            "404": problem
          }
        }
      },
      "/api/v1/locations/{locationId}/menus/{date}": {
        get: {
          tags: ["menus"],
          summary: "指定日の指定食堂メニュー",
          parameters: [{ $ref: "#/components/parameters/LocationId" }, { $ref: "#/components/parameters/Date" }],
          responses: {
            "200": {
              description: "指定食堂の日次メニュー",
              ...json({ $ref: "#/components/schemas/LocationMenuDocument" })
            },
            "400": problem,
            "404": problem
          }
        }
      },
      "/api/v1/sources": {
        get: {
          tags: ["sources"],
          summary: "取得元PDFの情報",
          responses: {
            "200": { description: "取得元PDFの情報", ...json({ $ref: "#/components/schemas/SourcesResponse" }) },
            "404": problem
          }
        }
      },
      "/api/v1/health": {
        get: {
          tags: ["health"],
          summary: "最新更新処理の状態",
          responses: {
            "200": { description: "最新更新処理の状態", ...json({ $ref: "#/components/schemas/HealthResponse" }) },
            "404": problem
          }
        }
      },
      "/api/v1/openapi.json": {
        get: {
          summary: "OpenAPI JSON",
          responses: {
            "200": { description: "OpenAPI JSON", ...json({ type: "object" }) },
            "404": problem
          }
        }
      }
    }
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
