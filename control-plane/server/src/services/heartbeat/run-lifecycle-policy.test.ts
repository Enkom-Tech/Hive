import { describe, expect, it } from "vitest";
import { parseHeartbeatPolicy } from "./run-lifecycle-policy.js";

function minimalAgent(overrides: Partial<{ runtimeConfig: unknown }> = {}) {
  return {
    id: "a1",
    companyId: "c1",
    name: "Test",
    adapterType: "managed_worker",
    status: "idle",
    runtimeConfig: overrides.runtimeConfig ?? null,
    role: "engineer",
    permissions: null,
    instructionsPath: null,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastHeartbeatAt: null,
    metadata: null,
  } as const;
}

describe("parseHeartbeatPolicy", () => {
  it("uses defaults when runtimeConfig is null", () => {
    const p = parseHeartbeatPolicy(minimalAgent() as never);
    expect(p.enabled).toBe(true);
    expect(p.intervalSec).toBe(0);
    expect(p.wakeOnDemand).toBe(true);
    expect(p.maxConcurrentRuns).toBeGreaterThanOrEqual(1);
  });

  it("reads heartbeat.enabled false", () => {
    const p = parseHeartbeatPolicy(
      minimalAgent({ runtimeConfig: { heartbeat: { enabled: false } } }) as never,
    );
    expect(p.enabled).toBe(false);
  });

  it("maps wakeOnAssignment to wakeOnDemand", () => {
    const p = parseHeartbeatPolicy(
      minimalAgent({ runtimeConfig: { heartbeat: { wakeOnAssignment: false } } }) as never,
    );
    expect(p.wakeOnDemand).toBe(false);
  });
});
