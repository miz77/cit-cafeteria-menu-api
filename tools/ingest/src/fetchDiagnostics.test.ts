import { describe, expect, it } from "vitest";
import { fetchErrorDetails, fetchFailureSlug, formatFetchErrorDetails } from "./fetchDiagnostics";

describe("fetch diagnostics", () => {
  it("extracts an undici cause code", () => {
    const error = errorWithCause("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError");
    const details = fetchErrorDetails(error);

    expect(details).toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      causeName: "ConnectTimeoutError",
      causeCode: "UND_ERR_CONNECT_TIMEOUT"
    });
    expect(fetchFailureSlug(details)).toBe("und_err_connect_timeout");
    expect(formatFetchErrorDetails(details)).toContain("causeCode=UND_ERR_CONNECT_TIMEOUT");
  });

  it("extracts the first nested code from AggregateError", () => {
    const nested = codedError("ECONNREFUSED", "Error");
    const aggregate = new AggregateError([nested], "All connection attempts failed");
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", { value: aggregate });

    const details = fetchErrorDetails(error);

    expect(details.causeName).toBe("AggregateError");
    expect(details.causeCode).toBe("ECONNREFUSED");
    expect(fetchFailureSlug(details)).toBe("econnrefused");
  });

  it("rounds unknown cause codes down to unknown", () => {
    const details = fetchErrorDetails(errorWithCause("SOME_VENDOR_CODE", "VendorNetworkError"));

    expect(details.causeCode).toBe("SOME_VENDOR_CODE");
    expect(fetchFailureSlug(details)).toBe("unknown");
  });
});

function errorWithCause(code: string, name: string): Error {
  const error = new TypeError("fetch failed");
  Object.defineProperty(error, "cause", { value: codedError(code, name) });
  return error;
}

function codedError(code: string, name: string): Error {
  const error = new Error(`network cause ${code}`) as Error & { code: string };
  error.name = name;
  error.code = code;
  return error;
}
