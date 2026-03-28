import { describe, expect, it } from "vitest";
import { stableRuntimeServiceId, stableStringify } from "./stable-ref.js";

describe("workspace-runtime stable id", () => {
  it("stableStringify sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("stableRuntimeServiceId is deterministic for same inputs", () => {
    const a = stableRuntimeServiceId({
      adapterType: "managed_worker",
      runId: "run-1",
      scopeType: "run",
      scopeId: "run-1",
      serviceName: "dev",
      reportId: null,
      providerRef: null,
      reuseKey: null,
    });
    const b = stableRuntimeServiceId({
      adapterType: "managed_worker",
      runId: "run-1",
      scopeType: "run",
      scopeId: "run-1",
      serviceName: "dev",
      reportId: null,
      providerRef: null,
      reuseKey: null,
    });
    expect(a).toBe(b);
    expect(a.startsWith("managed_worker-")).toBe(true);
  });

  it("stableRuntimeServiceId uses reportId when present", () => {
    expect(
      stableRuntimeServiceId({
        adapterType: "x",
        runId: "r",
        scopeType: "run",
        scopeId: "r",
        serviceName: "s",
        reportId: "explicit-id",
        providerRef: null,
        reuseKey: null,
      }),
    ).toBe("explicit-id");
  });
});
