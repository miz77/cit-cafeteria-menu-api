import {
  FALLBACK_SOURCES,
  LOCATION_IDS,
  type LocationId,
  PDF_BASENAME_TO_LOCATION_ID,
  SOURCE_PAGE_URL
} from "@cit-cafeteria/schema";

export interface IngestSource {
  locationId: LocationId;
  sourcePageUrl: string;
  pdfUrl: string;
  discovered: boolean;
  warnings: string[];
}

export interface SourceDiscoveryResult {
  sources: IngestSource[];
  warnings: string[];
}

export function discoverSourcesFromHtml(html: string, sourcePageUrl = SOURCE_PAGE_URL): SourceDiscoveryResult {
  const warnings: string[] = [];
  const discovered = new Map<LocationId, string>();

  for (const href of extractPdfHrefs(html)) {
    const url = normalizePdfUrl(href, sourcePageUrl);
    if (!url) continue;

    const basename = url.pathname.split("/").pop()?.toLowerCase();
    const locationId = basename
      ? PDF_BASENAME_TO_LOCATION_ID[basename as keyof typeof PDF_BASENAME_TO_LOCATION_ID]
      : undefined;
    if (!locationId) continue;
    if (!discovered.has(locationId)) discovered.set(locationId, url.toString());
  }

  const sources = LOCATION_IDS.map((locationId) => {
    const fallback = FALLBACK_SOURCES.find((source) => source.locationId === locationId);
    if (!fallback) throw new Error(`Missing fallback source for ${locationId}`);

    const pdfUrl = discovered.get(locationId);
    if (pdfUrl) {
      return {
        locationId,
        sourcePageUrl,
        pdfUrl,
        discovered: true,
        warnings: []
      };
    }

    const warning = `source_discovery_fallback:${locationId}`;
    warnings.push(warning);
    return {
      locationId,
      sourcePageUrl: fallback.sourcePageUrl,
      pdfUrl: fallback.pdfUrl,
      discovered: false,
      warnings: [warning]
    };
  });

  return { sources, warnings };
}

export function fallbackSources(reason: string): SourceDiscoveryResult {
  const warning = `source_discovery_fallback:${reason}`;
  return {
    warnings: [warning],
    sources: FALLBACK_SOURCES.map((source) => ({
      ...source,
      discovered: false,
      warnings: [warning]
    }))
  };
}

function extractPdfHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const pattern = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const href = decodeHtmlAttribute(match[2]);
    if (/\.pdf(?:[?#].*)?$/i.test(href)) hrefs.push(href);
  }
  return hrefs;
}

function normalizePdfUrl(href: string, sourcePageUrl: string): URL | null {
  try {
    const url = new URL(href, sourcePageUrl);
    if (url.hostname !== "www.cit-s.com") return null;
    if (!/\.pdf$/i.test(url.pathname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
