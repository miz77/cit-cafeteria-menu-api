import { describe, expect, it } from "vitest";
import { discoverSourcesFromHtml } from "./sources";

describe("source discovery", () => {
  it("maps PDF links by basename", () => {
    const result = discoverSourcesFromHtml(`
      <a href="/wp/wp-content/themes/cit/syokudo/t.pdf?ver=1">津田沼</a>
      <a href="https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/s1.pdf">新習志野1F</a>
      <a href="./wp/wp-content/themes/cit/syokudo/s2.pdf">新習志野2F</a>
    `);

    expect(
      result.sources.map((source) => [source.locationId, new URL(source.pdfUrl).pathname.split("/").pop()])
    ).toEqual([
      ["tsudanuma", "t.pdf"],
      ["shinnarashino-1f", "s1.pdf"],
      ["shinnarashino-2f", "s2.pdf"]
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("falls back per missing location", () => {
    const result = discoverSourcesFromHtml(`<a href="/wp/wp-content/themes/cit/syokudo/t.pdf">津田沼</a>`);

    expect(result.sources.find((source) => source.locationId === "tsudanuma")?.discovered).toBe(true);
    expect(result.sources.find((source) => source.locationId === "shinnarashino-1f")?.discovered).toBe(false);
    expect(result.warnings).toContain("source_discovery_fallback:shinnarashino-1f");
  });

  it("rejects non-CIT hosts", () => {
    const result = discoverSourcesFromHtml(`<a href="https://example.com/t.pdf">bad</a>`);

    expect(result.sources.every((source) => !source.discovered)).toBe(true);
  });
});
