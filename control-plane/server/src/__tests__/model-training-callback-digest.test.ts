import { describe, expect, it } from "vitest";
import { callbackBodyDigest } from "../services/model-training.js";

describe("callbackBodyDigest", () => {
  it("matches for equivalent payloads", () => {
    const a = callbackBodyDigest({
      runId: "550e8400-e29b-41d4-a716-446655440000",
      status: "succeeded",
      resultBaseUrl: "https://inf.example/v1",
      resultMetadata: { eval: { metrics: { acc: 0.9 } } },
      error: null,
      externalJobRef: null,
    });
    const b = callbackBodyDigest({
      runId: "550e8400-e29b-41d4-a716-446655440000",
      status: "succeeded",
      resultBaseUrl: "https://inf.example/v1",
      resultMetadata: { eval: { metrics: { acc: 0.9 } } },
      error: null,
      externalJobRef: null,
    });
    expect(a).toBe(b);
  });

  it("differs when status changes", () => {
    const base = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      resultBaseUrl: "https://inf.example/v1",
      resultMetadata: {},
      error: null,
      externalJobRef: null,
    };
    expect(callbackBodyDigest({ ...base, status: "running" })).not.toBe(
      callbackBodyDigest({ ...base, status: "succeeded" }),
    );
  });
});
