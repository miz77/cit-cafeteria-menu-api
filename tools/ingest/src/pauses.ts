import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseDateOnly } from "./dates";

export interface PausePeriod {
  from: string;
  to: string;
  reason: string;
}

interface PauseConfig {
  pausePeriods: PausePeriod[];
}

const DEFAULT_PAUSES_FILE = fileURLToPath(new URL("../pauses.json", import.meta.url));

export async function loadPausePeriods(filePath = DEFAULT_PAUSES_FILE): Promise<PausePeriod[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read pause periods: ${error instanceof Error ? error.message : String(error)}`);
  }

  return validatePauseConfig(parsed).pausePeriods;
}

export function isPausedOn(dateJst: string, periods: readonly PausePeriod[]): PausePeriod | null {
  parseDateOnly(dateJst);
  return periods.find((period) => period.from <= dateJst && dateJst <= period.to) ?? null;
}

function validatePauseConfig(value: unknown): PauseConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pause config must be an object.");
  }

  const pausePeriods = (value as { pausePeriods?: unknown }).pausePeriods;
  if (!Array.isArray(pausePeriods)) {
    throw new Error("Pause config must contain pausePeriods array.");
  }

  return {
    pausePeriods: pausePeriods.map((period, index) => validatePausePeriod(period, index))
  };
}

function validatePausePeriod(value: unknown, index: number): PausePeriod {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pausePeriods[${index}] must be an object.`);
  }

  const period = value as { from?: unknown; to?: unknown; reason?: unknown };
  if (typeof period.from !== "string") throw new Error(`pausePeriods[${index}].from must be a string.`);
  if (typeof period.to !== "string") throw new Error(`pausePeriods[${index}].to must be a string.`);
  if (typeof period.reason !== "string" || period.reason.trim() === "") {
    throw new Error(`pausePeriods[${index}].reason must be a non-empty string.`);
  }

  parseDateOnly(period.from);
  parseDateOnly(period.to);
  if (period.from > period.to) {
    throw new Error(`pausePeriods[${index}].from must be earlier than or equal to to.`);
  }

  return {
    from: period.from,
    to: period.to,
    reason: period.reason
  };
}
