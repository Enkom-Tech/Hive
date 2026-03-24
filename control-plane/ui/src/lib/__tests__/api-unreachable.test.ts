import { describe, expect, it } from "vitest";
import { apiUnreachableUserMessage, isLikelyApiUnreachableError } from "../api-unreachable";

describe("isLikelyApiUnreachableError", () => {
  it("detects typical browser fetch failures", () => {
    expect(isLikelyApiUnreachableError(new Error("Failed to fetch"))).toBe(true);
    expect(isLikelyApiUnreachableError(new Error("NetworkError when attempting to fetch"))).toBe(true);
  });

  it("detects health non-JSON messaging", () => {
    expect(
      isLikelyApiUnreachableError(new Error("Non-JSON response from /api/health (text/html)")),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isLikelyApiUnreachableError(new Error("Invalid credentials"))).toBe(false);
    expect(isLikelyApiUnreachableError(null)).toBe(false);
  });
});

describe("apiUnreachableUserMessage", () => {
  it("includes setup hint for unreachable errors", () => {
    const text = apiUnreachableUserMessage(new Error("Failed to fetch"));
    expect(text).toContain("control plane API");
    expect(text).toContain("pnpm dev");
  });

  it("returns the server message for other errors", () => {
    expect(apiUnreachableUserMessage(new Error("Invalid credentials"))).toBe("Invalid credentials");
  });

  it("explains rate limiting when the server returns too many requests", () => {
    const text = apiUnreachableUserMessage(new Error("Too many requests"));
    expect(text).toContain("rate-limited");
    expect(text).toContain("HIVE_RATE_LIMIT_MAX");
  });

  it("returns a generic line for non-errors", () => {
    expect(apiUnreachableUserMessage(null)).toBe("Request failed.");
  });
});
