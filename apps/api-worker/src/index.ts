import { isLocationId, kvKeys } from "@cit-cafeteria/schema";

export interface Env {
  MENU_KV: KVNamespace;
  TIMEZONE?: string;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-max-age": "86400"
} as const;

const JSON_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const NO_STORE = "no-store";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return problem(405, "Method not allowed", `${request.method} is not allowed.`, new URL(request.url).pathname, {
      allow: "GET, HEAD, OPTIONS"
    });
  }

  const url = new URL(request.url);
  const path = stripTrailingSlash(url.pathname);
  const key = routeToKvKey(path);

  if (key.kind === "problem") {
    return problem(key.status, key.title, key.detail, path);
  }

  return jsonFromKv(env, key.key, request, {
    cacheControl: key.cacheControl,
    notFoundTitle: key.notFoundTitle,
    notFoundDetail: key.notFoundDetail
  });
}

type RouteResult =
  | {
      kind: "kv";
      key: string;
      cacheControl: string;
      notFoundTitle: string;
      notFoundDetail: string;
    }
  | {
      kind: "problem";
      status: number;
      title: string;
      detail: string;
    };

export function routeToKvKey(path: string): RouteResult {
  if (path === "/api/v1/locations") {
    return kv(kvKeys.locations, "Locations not found", "Generated locations document was not found.");
  }

  if (path === "/api/v1/menus/today") {
    return kv(kvKeys.menuAll(todayInAsiaTokyo()), "Menu not found", "No generated menu document exists for today.");
  }

  if (path === "/api/v1/menus/week") {
    const weekStartDate = weekStartDateInAsiaTokyo();
    return kv(
      kvKeys.menuWeekAll(weekStartDate),
      "Menu not found",
      `No generated week menu document exists for the week starting ${weekStartDate}.`
    );
  }

  const menuPath = path.match(/^\/api\/v1\/menus\/([^/]+)$/);
  if (menuPath) {
    const date = menuPath[1];
    const dateValidation = validateDatePathSegment(date);
    if (dateValidation) return dateValidation;
    return kv(kvKeys.menuAll(date), "Menu not found", `No generated menu document exists for ${date}.`);
  }

  const locationTodayPath = path.match(/^\/api\/v1\/locations\/([^/]+)\/menus\/today$/);
  if (locationTodayPath) {
    const locationId = locationTodayPath[1];
    if (!isLocationId(locationId)) {
      return problemRoute(404, "Unknown location", `Unknown locationId: ${locationId}`);
    }
    const date = todayInAsiaTokyo();
    return kv(
      kvKeys.menuLocation(date, locationId),
      "Menu not found",
      `No generated menu document exists for ${locationId} today.`
    );
  }

  const locationWeekPath = path.match(/^\/api\/v1\/locations\/([^/]+)\/menus\/week$/);
  if (locationWeekPath) {
    const locationId = locationWeekPath[1];
    if (!isLocationId(locationId)) {
      return problemRoute(404, "Unknown location", `Unknown locationId: ${locationId}`);
    }
    const weekStartDate = weekStartDateInAsiaTokyo();
    return kv(
      kvKeys.menuWeek(weekStartDate, locationId),
      "Menu not found",
      `No generated week menu document exists for ${locationId} in the week starting ${weekStartDate}.`
    );
  }

  const locationMenuPath = path.match(/^\/api\/v1\/locations\/([^/]+)\/menus\/([^/]+)$/);
  if (locationMenuPath) {
    const locationId = locationMenuPath[1];
    const date = locationMenuPath[2];
    if (!isLocationId(locationId)) {
      return problemRoute(404, "Unknown location", `Unknown locationId: ${locationId}`);
    }
    const dateValidation = validateDatePathSegment(date);
    if (dateValidation) return dateValidation;
    return kv(
      kvKeys.menuLocation(date, locationId),
      "Menu not found",
      `No generated menu document exists for ${locationId} on ${date}.`
    );
  }

  if (path === "/api/v1/sources") {
    return kv(kvKeys.sourceCurrent, "Sources not found", "Current source metadata was not found.");
  }

  if (path === "/api/v1/health") {
    return kv(kvKeys.healthCurrent, "Health not found", "Current health document was not found.", NO_STORE);
  }

  if (path === "/api/v1/openapi.json") {
    return kv(kvKeys.openapiJson, "OpenAPI not found", "OpenAPI JSON document was not found.");
  }

  return problemRoute(404, "Not found", "No route matched.");
}

function kv(
  key: string,
  notFoundTitle: string,
  notFoundDetail: string,
  cacheControl = JSON_CACHE_CONTROL
): RouteResult {
  return {
    kind: "kv",
    key,
    cacheControl,
    notFoundTitle,
    notFoundDetail
  };
}

function problemRoute(status: number, title: string, detail: string): RouteResult {
  return {
    kind: "problem",
    status,
    title,
    detail
  };
}

function validateDatePathSegment(date: string): RouteResult | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return problemRoute(400, "Invalid date", "date must be YYYY-MM-DD");
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return problemRoute(400, "Invalid date", "date must be a real calendar date");
  }

  return null;
}

async function jsonFromKv(
  env: Env,
  key: string,
  request: Request,
  options: {
    cacheControl: string;
    notFoundTitle: string;
    notFoundDetail: string;
  }
): Promise<Response> {
  const value = await env.MENU_KV.get(key);
  if (!value) {
    return problem(404, options.notFoundTitle, options.notFoundDetail, new URL(request.url).pathname);
  }

  const headers = {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": options.cacheControl
  };

  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }

  return new Response(value, { headers });
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

function problem(
  status: number,
  title: string,
  detail: string,
  instance: string,
  options?: { allow?: string }
): Response {
  const headers: HeadersInit = {
    ...CORS_HEADERS,
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": NO_STORE
  };

  if (options?.allow) headers.allow = options.allow;

  return Response.json(
    {
      type: `urn:cit-cafeteria-menu-api:problem:${slugify(title)}`,
      title,
      status,
      detail,
      instance
    },
    {
      status,
      headers
    }
  );
}

function todayInAsiaTokyo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) throw new Error("Failed to format Asia/Tokyo date");
  return `${year}-${month}-${day}`;
}

function weekStartDateInAsiaTokyo(now = new Date()): string {
  const today = todayInAsiaTokyo(now);
  const date = new Date(`${today}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function stripTrailingSlash(path: string): string {
  if (path !== "/" && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const __test__ = {
  todayInAsiaTokyo,
  weekStartDateInAsiaTokyo,
  validateDatePathSegment,
  stripTrailingSlash
};
