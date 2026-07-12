import type { HealthResponse, LocationStatus, MenuWeekDay } from "@cit-cafeteria/schema";

export interface GeneratedRunOutcome {
  healthStatus: HealthResponse["status"];
  lastError: string | null;
  rejectAfterUpload: boolean;
}

const TRUSTED_STATUSES = new Set<LocationStatus>(["ok", "closed", "not_published"]);

export function aggregateGeneratedRun(days: readonly MenuWeekDay[]): GeneratedRunOutcome {
  const statuses = days.flatMap((day) => day.locations.map((location) => location.status));
  const untrusted = statuses.filter((status) => !TRUSTED_STATUSES.has(status));

  if (untrusted.length === 0) {
    return { healthStatus: "ok", lastError: null, rejectAfterUpload: false };
  }

  const counts = Array.from(new Set(untrusted)).map(
    (status) => `${status}:${untrusted.filter((candidate) => candidate === status).length}`
  );
  const lastError = `Untrusted location-day statuses were generated (${counts.join(", ")}).`;
  const hasTrusted = statuses.some((status) => TRUSTED_STATUSES.has(status));

  return {
    healthStatus: hasTrusted ? "degraded" : "failed",
    lastError,
    rejectAfterUpload: !hasTrusted
  };
}
