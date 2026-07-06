export const INGEST_USER_AGENT =
  "cit-cafeteria-menu-api/0.2 (+https://github.com/miz77/cit-cafeteria-menu-api; unofficial)";

const KNOWN_FETCH_FAILURE_CODES = new Set([
  "ABORT_ERR",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

export interface FetchErrorDetails {
  name: string;
  message: string;
  causeName: string | null;
  causeMessage: string | null;
  causeCode: string | null;
}

export function fetchErrorDetails(error: unknown): FetchErrorDetails {
  const cause = property(error, "cause");
  const nestedCause = firstAggregateError(cause);
  const causeDetail = nestedCause ?? cause;

  return {
    name: stringProperty(error, "name") ?? "unknown",
    message: stringProperty(error, "message") ?? String(error),
    causeName: stringProperty(cause, "name") ?? stringProperty(causeDetail, "name"),
    causeMessage: stringProperty(causeDetail, "message") ?? stringProperty(cause, "message"),
    causeCode: stringProperty(causeDetail, "code") ?? stringProperty(cause, "code")
  };
}

export function fetchFailureSlug(details: FetchErrorDetails): string {
  const code = details.causeCode?.toUpperCase();
  if (code && KNOWN_FETCH_FAILURE_CODES.has(code)) return normalizeSlug(code);
  if (details.name === "AbortError" || details.causeName === "AbortError") return "abort_err";
  if (details.name === "TimeoutError" || details.causeName === "TimeoutError") return "timeout_error";
  return "unknown";
}

export function formatFetchErrorDetails(details: FetchErrorDetails): string {
  const parts = [`${details.name}: ${details.message}`];
  if (details.causeName) parts.push(`causeName=${details.causeName}`);
  if (details.causeCode) parts.push(`causeCode=${details.causeCode}`);
  if (details.causeMessage) parts.push(`causeMessage=${JSON.stringify(details.causeMessage)}`);
  return parts.join(" ");
}

export function logFetchFailure(phase: string, url: string, error: unknown, stage?: string): FetchErrorDetails {
  const details = fetchErrorDetails(error);
  console.warn(
    ["Fetch failed:", `phase=${phase}`, stage ? `stage=${stage}` : null, `url=${url}`, formatFetchErrorDetails(details)]
      .filter(Boolean)
      .join(" ")
  );
  return details;
}

function firstAggregateError(value: unknown): unknown {
  const errors = property(value, "errors");
  if (Array.isArray(errors) && errors.length > 0) return errors[0];
  return undefined;
}

function stringProperty(value: unknown, key: string): string | null {
  const result = property(value, key);
  return typeof result === "string" && result.length > 0 ? result : null;
}

function property(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return (value as Record<string, unknown>)[key];
}

function normalizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "unknown";
}
