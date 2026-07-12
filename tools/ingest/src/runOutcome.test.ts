import type { LocationMenu, MenuWeekDay } from "@cit-cafeteria/schema";
import { describe, expect, it } from "vitest";
import { aggregateGeneratedRun } from "./runOutcome";

describe("generated run outcome", () => {
  it("treats ok, closed, and not-published location days as trusted", () => {
    expect(aggregateGeneratedRun([day("ok", "closed", "not_published")])).toEqual({
      healthStatus: "ok",
      lastError: null,
      rejectAfterUpload: false
    });
  });

  it("degrades a run containing both trusted and unknown location days", () => {
    expect(aggregateGeneratedRun([day("ok", "unknown", "closed")])).toMatchObject({
      healthStatus: "degraded",
      rejectAfterUpload: false,
      lastError: expect.stringContaining("unknown:1")
    });
  });

  it("fails after upload when every generated location day is untrusted", () => {
    expect(aggregateGeneratedRun([day("unknown", "parse_failed", "fetch_failed")])).toMatchObject({
      healthStatus: "failed",
      rejectAfterUpload: true
    });
  });
});

function day(...statuses: LocationMenu["status"][]): MenuWeekDay {
  return {
    date: "2026-07-13",
    overallStatus: "failed",
    warnings: [],
    locations: statuses.map((status, index) => location(status, index))
  };
}

function location(status: LocationMenu["status"], index: number): LocationMenu {
  const identities = [
    { id: "tsudanuma" as const, name: "津田沼", campus: "津田沼" as const, floor: null },
    { id: "shinnarashino-1f" as const, name: "新習志野1F", campus: "新習志野" as const, floor: "1F" as const },
    { id: "shinnarashino-2f" as const, name: "新習志野2F", campus: "新習志野" as const, floor: "2F" as const }
  ];
  return {
    ...identities[index],
    status,
    menuText: { format: "plain_text", rawText: null, lines: [] },
    menuItems: [],
    unassignedLines: [],
    parser: { version: "test", confidence: 0, warnings: [] },
    source: { sourcePageUrl: "https://example.com", pdfUrl: "https://example.com/menu.pdf" }
  };
}
