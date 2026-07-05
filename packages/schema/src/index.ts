export type LocationId = "tsudanuma" | "shinnarashino-1f" | "shinnarashino-2f";

export const TIMEZONE = "Asia/Tokyo";
export const SCHEMA_VERSION = "1.1";
export const HISTORY_TTL_SECONDS = 35 * 24 * 60 * 60;

export const LOCATION_IDS = [
  "tsudanuma",
  "shinnarashino-1f",
  "shinnarashino-2f"
] as const satisfies readonly LocationId[];

export const LOCATIONS = [
  {
    id: "tsudanuma",
    name: "津田沼食堂",
    campus: "津田沼",
    floor: null
  },
  {
    id: "shinnarashino-1f",
    name: "新習志野食堂 1F",
    campus: "新習志野",
    floor: "1F"
  },
  {
    id: "shinnarashino-2f",
    name: "新習志野食堂 2F",
    campus: "新習志野",
    floor: "2F"
  }
] as const satisfies readonly LocationBase[];

export const SOURCE_PAGE_URL = "https://www.cit-s.com/dining/";

export const FALLBACK_SOURCES = [
  {
    locationId: "tsudanuma",
    sourcePageUrl: SOURCE_PAGE_URL,
    pdfUrl: "https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/t.pdf"
  },
  {
    locationId: "shinnarashino-1f",
    sourcePageUrl: SOURCE_PAGE_URL,
    pdfUrl: "https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/s1.pdf"
  },
  {
    locationId: "shinnarashino-2f",
    sourcePageUrl: SOURCE_PAGE_URL,
    pdfUrl: "https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/s2.pdf"
  }
] as const;

export const PDF_BASENAME_TO_LOCATION_ID = {
  "t.pdf": "tsudanuma",
  "s1.pdf": "shinnarashino-1f",
  "s2.pdf": "shinnarashino-2f"
} as const satisfies Record<string, LocationId>;

export const PROJECT_NOTICE = {
  name: "cit-cafeteria-menu-api",
  license: "MIT"
} as const satisfies ProjectNotice;

export const DATA_NOTICE = {
  official: false,
  source: "CITサービス学食メニューPDF",
  license: null
} as const satisfies DataNotice;

export const UNOFFICIAL_NOTICE =
  "This is an unofficial API generated from public cafeteria PDFs. Accuracy is not guaranteed. Please check the original PDF for official information.";

export type LocationStatus =
  | "ok"
  | "closed"
  | "not_published"
  | "fetch_failed"
  | "parse_failed"
  | "source_changed"
  | "source_too_large"
  | "unknown";

export type OverallStatus = "ok" | "partial" | "failed" | "stale";

export interface LocationBase {
  id: LocationId;
  name: string;
  campus: "津田沼" | "新習志野";
  floor: "1F" | "2F" | null;
}

export interface LocationMenu extends LocationBase {
  status: LocationStatus;
  statusMessage?: string;
  menuText: {
    format: "plain_text";
    rawText: string | null;
    lines: string[];
  };
  menuItems: MenuItem[];
  unassignedLines: string[];
  parser: {
    version: string;
    confidence: number;
    warnings: string[];
  };
  source: {
    sourcePageUrl: string;
    pdfUrl: string;
    fetchedAt?: string;
    sha256?: string;
  };
}

export type MenuCategory =
  | "asa_teishoku"
  | "koudai_teishoku"
  | "yu_teishoku"
  | "higawari_salad"
  | "gourmet_curry"
  | "men_corner"
  | "keishoku_pasta"
  | "unknown";

export type MenuItemWarning = "price_not_found" | "category_unknown" | "name_may_be_incomplete";

export interface MenuItem {
  name: string;
  nameLines: string[];
  category: MenuCategory;
  categoryLabel: string | null;
  priceYen: number | null;
  priceText: string | null;
  confidence: 0.9 | 0.6 | 0.3;
  warnings: MenuItemWarning[];
}

export interface ProjectNotice {
  name: "cit-cafeteria-menu-api";
  license: "MIT";
  repository?: string;
}

export interface DataNotice {
  official: false;
  source: "CITサービス学食メニューPDF";
  license: null;
}

export interface MenuDocument {
  schemaVersion: "1.1";
  documentKind: "all-locations";
  date: string;
  timezone: "Asia/Tokyo";
  generatedAt: string;
  overallStatus: OverallStatus;
  locations: LocationMenu[];
  warnings: string[];
  notice: string;
  project: ProjectNotice;
  dataNotice: DataNotice;
}

export interface LocationMenuDocument {
  schemaVersion: "1.1";
  documentKind: "single-location";
  date: string;
  timezone: "Asia/Tokyo";
  generatedAt: string;
  location: LocationMenu;
  warnings: string[];
  notice: string;
  project: ProjectNotice;
  dataNotice: DataNotice;
}

export interface MenuWeekDay {
  date: string;
  overallStatus: OverallStatus;
  locations: LocationMenu[];
  warnings: string[];
}

export interface LocationMenuWeekDay {
  date: string;
  location: LocationMenu;
  warnings: string[];
}

export interface MenuWeekDocument {
  schemaVersion: "1.1";
  documentKind: "week";
  scope: "all-locations";
  weekStartDate: string;
  timezone: "Asia/Tokyo";
  generatedAt: string;
  overallStatus: OverallStatus;
  days: MenuWeekDay[];
  warnings: string[];
  notice: string;
  project: ProjectNotice;
  dataNotice: DataNotice;
}

export interface LocationMenuWeekDocument {
  schemaVersion: "1.1";
  documentKind: "week";
  scope: "single-location";
  weekStartDate: string;
  timezone: "Asia/Tokyo";
  generatedAt: string;
  location: LocationBase;
  days: LocationMenuWeekDay[];
  warnings: string[];
  notice: string;
  project: ProjectNotice;
  dataNotice: DataNotice;
}

export interface LocationsResponse {
  locations: LocationBase[];
}

export interface SourceRecord {
  locationId: LocationId;
  sourcePageUrl: string;
  pdfUrl: string;
  fetchedAt?: string;
  sha256?: string;
  status?: string;
  warnings?: string[];
}

export interface SourcesResponse {
  weekStartDate: string;
  generatedAt: string;
  sources: SourceRecord[];
  warnings: string[];
}

export interface HealthResponse {
  status: "ok" | "degraded" | "failed" | "unknown";
  checkedAt: string;
  weekStartDate?: string;
  generatedAt?: string;
  lastError?: string | null;
}

export function isLocationId(value: string): value is LocationId {
  return (LOCATION_IDS as readonly string[]).includes(value);
}

export const kvKeys = {
  locations: "static:v1:locations",
  openapiJson: "static:v1:openapi-json",
  menuAll(date: string): string {
    return `menu:v1:date:${date}:all`;
  },
  menuLocation(date: string, locationId: LocationId): string {
    return `menu:v1:date:${date}:location:${locationId}`;
  },
  menuWeekAll(weekStartDate: string): string {
    return `menu:v1:week:${weekStartDate}:all`;
  },
  menuWeek(weekStartDate: string, locationId: LocationId): string {
    return `menu:v1:week:${weekStartDate}:location:${locationId}`;
  },
  sourceWeek(weekStartDate: string): string {
    return `source:v1:week:${weekStartDate}`;
  },
  sourceCurrent: "source:v1:week:current",
  healthCurrent: "health:v1:current",
  healthLastUpdate: "health:v1:last-update",
  healthLastError: "health:v1:last-error"
} as const;

export function createEmptyLocationMenu(
  locationId: LocationId,
  status: LocationStatus,
  statusMessage: string,
  source: LocationMenu["source"],
  parserWarnings: string[] = []
): LocationMenu {
  const location = LOCATIONS.find((item) => item.id === locationId);
  if (!location) throw new Error(`Unknown locationId: ${locationId}`);

  return {
    ...location,
    status,
    statusMessage,
    menuText: {
      format: "plain_text",
      rawText: null,
      lines: []
    },
    menuItems: [],
    unassignedLines: [],
    parser: {
      version: "simple-column-v2",
      confidence: 0,
      warnings: parserWarnings
    },
    source
  };
}

export function computeOverallStatus(locations: readonly LocationMenu[]): OverallStatus {
  const usable = locations.filter((location) => location.status === "ok" || location.status === "closed").length;
  if (usable === locations.length) return "ok";
  if (usable === 0) return "failed";
  return "partial";
}

export function assertMenuDocument(
  value: MenuDocument | LocationMenuDocument | MenuWeekDocument | LocationMenuWeekDocument
): void {
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("Invalid schemaVersion");
  if (value.timezone !== TIMEZONE) throw new Error("Invalid timezone");
  if (!value.generatedAt) throw new Error("Missing generatedAt");
  if (!value.notice) throw new Error("Missing notice");
  if (value.project.name !== PROJECT_NOTICE.name || value.project.license !== PROJECT_NOTICE.license) {
    throw new Error("Invalid project notice");
  }
  if (value.dataNotice.official !== false || value.dataNotice.license !== null) {
    throw new Error("Invalid data notice");
  }

  if (value.documentKind === "week") {
    assertWeekMenuDocument(value);
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new Error("Invalid date");
  const locations = value.documentKind === "all-locations" ? value.locations : [value.location];
  for (const location of locations) {
    assertLocationMenu(location);
  }
}

function assertWeekMenuDocument(value: MenuWeekDocument | LocationMenuWeekDocument): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.weekStartDate)) throw new Error("Invalid weekStartDate");
  if (value.days.length === 0) throw new Error("Week document must contain at least one day");

  if (value.scope === "all-locations") {
    for (const day of value.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new Error("Invalid week day date");
      for (const location of day.locations) assertLocationMenu(location);
    }
    return;
  }

  for (const day of value.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new Error("Invalid week day date");
    assertLocationMenu(day.location);
  }
}

function assertLocationMenu(location: LocationMenu): void {
  if (!isLocationId(location.id)) throw new Error(`Invalid location id: ${location.id}`);
  if (location.menuText.format !== "plain_text") throw new Error("Invalid menu text format");
  if (location.menuText.rawText !== null && location.menuText.rawText.length > 20_000) {
    throw new Error(`rawText too long for ${location.id}`);
  }
  if (location.status !== "ok" && location.menuText.lines.length === 0 && !location.statusMessage) {
    throw new Error(`Missing statusMessage for empty non-ok menu: ${location.id}`);
  }
  if (location.status !== "ok" && location.menuItems.length !== 0) {
    throw new Error(`Non-ok menu must not contain structured menuItems: ${location.id}`);
  }
  for (const item of location.menuItems) {
    assertMenuItem(location.id, item);
  }
  if (location.parser.confidence < 0 || location.parser.confidence > 1) {
    throw new Error(`Invalid parser confidence for ${location.id}`);
  }
  if (!location.source.sourcePageUrl || !location.source.pdfUrl) {
    throw new Error(`Missing source provenance for ${location.id}`);
  }
}

function assertMenuItem(locationId: LocationId, item: MenuItem): void {
  if (!item.name.trim()) throw new Error(`Missing menu item name for ${locationId}`);
  if (item.nameLines.length === 0 || item.nameLines.some((line) => !line.trim())) {
    throw new Error(`Invalid menu item nameLines for ${locationId}`);
  }
  if (!MENU_CATEGORIES.includes(item.category)) {
    throw new Error(`Invalid menu item category for ${locationId}`);
  }
  if (item.categoryLabel !== null && !item.categoryLabel.trim()) {
    throw new Error(`Invalid menu item categoryLabel for ${locationId}`);
  }
  if (item.priceYen !== null && (!Number.isInteger(item.priceYen) || item.priceYen <= 0)) {
    throw new Error(`Invalid menu item priceYen for ${locationId}`);
  }
  if (item.priceText !== null && !item.priceText.trim()) {
    throw new Error(`Invalid menu item priceText for ${locationId}`);
  }
  if (!MENU_ITEM_CONFIDENCES.includes(item.confidence)) {
    throw new Error(`Invalid menu item confidence for ${locationId}`);
  }
  for (const warning of item.warnings) {
    if (!MENU_ITEM_WARNINGS.includes(warning)) {
      throw new Error(`Invalid menu item warning for ${locationId}: ${warning}`);
    }
  }
}

const MENU_CATEGORIES = [
  "asa_teishoku",
  "koudai_teishoku",
  "yu_teishoku",
  "higawari_salad",
  "gourmet_curry",
  "men_corner",
  "keishoku_pasta",
  "unknown"
] as const satisfies readonly MenuCategory[];

const MENU_ITEM_CONFIDENCES = [0.9, 0.6, 0.3] as const satisfies readonly MenuItem["confidence"][];

const MENU_ITEM_WARNINGS = [
  "price_not_found",
  "category_unknown",
  "name_may_be_incomplete"
] as const satisfies readonly MenuItemWarning[];
