import { describe, expect, it } from "vitest";
import { isExternalRun } from "../services/heartbeat/index.js";

describe("isExternalRun", () => {
  it("returns true when triggerDetail is external_agent_checkout", () => {
    expect(isExternalRun({ triggerDetail: "external_agent_checkout" })).toBe(true);
  });

  it("returns false for other trigger details", () => {
    expect(isExternalRun({ triggerDetail: "manual" })).toBe(false);
    expect(isExternalRun({ triggerDetail: "system" })).toBe(false);
    expect(isExternalRun({ triggerDetail: "ping" })).toBe(false);
    expect(isExternalRun({ triggerDetail: "callback" })).toBe(false);
  });

  it("returns false when triggerDetail is null", () => {
    expect(isExternalRun({ triggerDetail: null })).toBe(false);
  });
});
