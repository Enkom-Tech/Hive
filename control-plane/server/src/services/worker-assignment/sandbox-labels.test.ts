import { describe, expect, it } from "vitest";
import { workerInstanceLabelsAllowSandboxPosture } from "./sandbox-labels.js";

describe("workerInstanceLabelsAllowSandboxPosture", () => {
  it("returns false for missing or non-object labels", () => {
    expect(workerInstanceLabelsAllowSandboxPosture(null)).toBe(false);
    expect(workerInstanceLabelsAllowSandboxPosture([])).toBe(false);
    expect(workerInstanceLabelsAllowSandboxPosture("x")).toBe(false);
  });

  it("returns true only when sandbox is boolean true", () => {
    expect(workerInstanceLabelsAllowSandboxPosture({ sandbox: true })).toBe(true);
    expect(workerInstanceLabelsAllowSandboxPosture({ sandbox: "true" })).toBe(false);
    expect(workerInstanceLabelsAllowSandboxPosture({ sandbox: false })).toBe(false);
    expect(workerInstanceLabelsAllowSandboxPosture({})).toBe(false);
  });
});
