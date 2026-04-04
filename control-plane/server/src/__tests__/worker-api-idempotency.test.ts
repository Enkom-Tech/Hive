import { describe, expect, it } from "vitest";
import { parseWorkerApiIdempotencyKey } from "../routes/worker-api-idempotency.js";
import { HttpError } from "../errors.js";
import type { HeaderCarrier } from "../routes/authz.js";

function mockReq(headers: Record<string, string | undefined>): HeaderCarrier {
  const lowercased: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowercased[k.toLowerCase()] = v;
  }
  return { headers: lowercased as Record<string, string | string[] | undefined> };
}

describe("parseWorkerApiIdempotencyKey", () => {
  it("returns null when header absent", () => {
    expect(parseWorkerApiIdempotencyKey(mockReq({}))).toBeNull();
  });

  it("trims and accepts printable ASCII", () => {
    expect(parseWorkerApiIdempotencyKey(mockReq({ "x-hive-worker-idempotency-key": "  abc-1  " }))).toBe("abc-1");
  });

  it("rejects empty after trim", () => {
    expect(() => parseWorkerApiIdempotencyKey(mockReq({ "x-hive-worker-idempotency-key": "   " }))).toThrow(HttpError);
  });

  it("rejects too long", () => {
    const k = "a".repeat(129);
    expect(() => parseWorkerApiIdempotencyKey(mockReq({ "x-hive-worker-idempotency-key": k }))).toThrow(HttpError);
  });

  it("rejects non-printable ASCII", () => {
    expect(() =>
      parseWorkerApiIdempotencyKey(mockReq({ "x-hive-worker-idempotency-key": "a\tb" })),
    ).toThrow(HttpError);
  });
});