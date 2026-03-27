import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { parseWorkerApiIdempotencyKey } from "../routes/worker-api-idempotency.js";
import { HttpError } from "../errors.js";

function mockReq(headers: Record<string, string | undefined>): Request {
  return {
    get(name: string) {
      const want = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === want) return v;
      }
      return undefined;
    },
  } as unknown as Request;
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