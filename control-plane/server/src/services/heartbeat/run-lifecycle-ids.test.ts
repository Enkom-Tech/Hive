import { describe, expect, it } from "vitest";
import { isUuidFormattedRunId } from "./run-lifecycle-ids.js";

describe("run-lifecycle-ids", () => {
  it("accepts canonical lowercase UUID", () => {
    expect(isUuidFormattedRunId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts uppercase UUID", () => {
    expect(isUuidFormattedRunId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects empty and non-uuid", () => {
    expect(isUuidFormattedRunId("")).toBe(false);
    expect(isUuidFormattedRunId("not-a-uuid")).toBe(false);
    expect(isUuidFormattedRunId("550e8400-e29b-41d4-a716")).toBe(false);
  });
});
