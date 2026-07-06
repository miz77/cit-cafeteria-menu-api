import { describe, expect, it, vi } from "vitest";
import worker, { __test__, type Env, routeToKvKey } from "./index";

class FakeKv {
  readonly calls: string[] = [];

  constructor(private readonly values: Record<string, string>) {}

  async get(key: string): Promise<string | null> {
    this.calls.push(key);
    return this.values[key] ?? null;
  }
}

function env(values: Record<string, string>): Env & { MENU_KV: KVNamespace; fakeKv: FakeKv } {
  const fakeKv = new FakeKv(values);
  return {
    MENU_KV: fakeKv as unknown as KVNamespace,
    DOCS_URL: "https://cit-cafeteria-menu-api.pages.dev/",
    fakeKv
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.test${path}`, init);
}

describe("API Worker routing", () => {
  it("maps all-location fixed date menus to one KV key", async () => {
    const testEnv = env({ "menu:v1:date:2026-07-06:all": '{"ok":true}' });
    const response = await worker.fetch(request("/api/v1/menus/2026-07-06"), testEnv);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(testEnv.fakeKv.calls).toEqual(["menu:v1:date:2026-07-06:all"]);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("maps location fixed date menus to location-specific KV keys", () => {
    expect(routeToKvKey("/api/v1/locations/tsudanuma/menus/2026-07-06")).toMatchObject({
      kind: "kv",
      key: "menu:v1:date:2026-07-06:location:tsudanuma"
    });
  });

  it("maps current week menus before generic date routes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      expect(routeToKvKey("/api/v1/menus/week")).toMatchObject({
        kind: "kv",
        key: "menu:v1:week:2026-06-29:all"
      });
      expect(routeToKvKey("/api/v1/locations/tsudanuma/menus/week")).toMatchObject({
        kind: "kv",
        key: "menu:v1:week:2026-06-29:location:tsudanuma"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed and impossible dates with 400", async () => {
    const testEnv = env({});

    const malformed = await worker.fetch(request("/api/v1/menus/2026-7-6"), testEnv);
    const impossible = await worker.fetch(request("/api/v1/menus/2026-02-30"), testEnv);

    expect(malformed.status).toBe(400);
    expect(impossible.status).toBe(400);
    expect(testEnv.fakeKv.calls).toEqual([]);
  });

  it("rejects unknown locations with 404 before KV access", async () => {
    const testEnv = env({});
    const response = await worker.fetch(request("/api/v1/locations/unknown/menus/2026-07-06"), testEnv);

    expect(response.status).toBe(404);
    expect(testEnv.fakeKv.calls).toEqual([]);
  });

  it("supports HEAD without a body", async () => {
    const testEnv = env({ "static:v1:locations": '{"locations":[]}' });
    const response = await worker.fetch(request("/api/v1/locations", { method: "HEAD" }), testEnv);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(testEnv.fakeKv.calls).toEqual(["static:v1:locations"]);
  });

  it("supports CORS preflight and rejects unsupported methods", async () => {
    const testEnv = env({});

    const options = await worker.fetch(request("/api/v1/locations", { method: "OPTIONS" }), testEnv);
    const post = await worker.fetch(request("/api/v1/locations", { method: "POST" }), testEnv);

    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toContain("GET");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("redirects /docs to the configured documentation URL without KV access", async () => {
    const testEnv = env({});
    const response = await worker.fetch(request("/docs?next=https://example.invalid"), testEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://cit-cafeteria-menu-api.pages.dev/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(testEnv.fakeKv.calls).toEqual([]);
  });

  it("uses endpoint-ready health and OpenAPI KV keys", async () => {
    const testEnv = env({
      "health:v1:current": '{"status":"ok","checkedAt":"2026-07-03T00:00:00.000Z"}',
      "static:v1:openapi-json": '{"openapi":"3.1.0"}'
    });

    const health = await worker.fetch(request("/api/v1/health"), testEnv);
    const openapi = await worker.fetch(request("/api/v1/openapi.json"), testEnv);

    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(openapi.status).toBe(200);
    expect(testEnv.fakeKv.calls).toEqual(["health:v1:current", "static:v1:openapi-json"]);
  });

  it("formats Asia/Tokyo today across UTC day boundaries", () => {
    expect(__test__.todayInAsiaTokyo(new Date("2026-07-02T15:00:00.000Z"))).toBe("2026-07-03");
    expect(__test__.weekStartDateInAsiaTokyo(new Date("2026-07-04T15:00:00.000Z"))).toBe("2026-06-29");
  });

  it("normalizes only https documentation URLs", () => {
    expect(__test__.normalizeDocsUrl("https://cit-cafeteria-menu-api.pages.dev")).toBe(
      "https://cit-cafeteria-menu-api.pages.dev/"
    );
    expect(__test__.normalizeDocsUrl("http://cit-cafeteria-menu-api.pages.dev")).toBeNull();
    expect(__test__.normalizeDocsUrl("not a url")).toBeNull();
  });
});
