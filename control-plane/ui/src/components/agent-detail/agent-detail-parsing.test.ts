import { describe, expect, it } from "vitest";
import { asNonEmptyString, asRecord } from "./agent-detail-parsing";

describe("agent-detail-parsing", () => {
  it("asRecord rejects arrays and null", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("asNonEmptyString trims and rejects blank", () => {
    expect(asNonEmptyString("  x  ")).toBe("x");
    expect(asNonEmptyString("   ")).toBeNull();
    expect(asNonEmptyString(1)).toBeNull();
  });
});
