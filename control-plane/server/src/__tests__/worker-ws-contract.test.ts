import { describe, expect, it } from "vitest";

/**
 * Golden shapes for messages sent on /api/workers/link (DRONE-SPEC §10).
 * Keep in sync with infra/worker/internal/wscontract and adapters/managed-worker/execute.ts
 */
describe("worker WebSocket contract (CP → worker)", () => {
  it("run envelope has required keys", () => {
    const payload = {
      type: "run",
      runId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "agent-1",
      context: { task: "x" },
      adapterKey: "managed_worker",
      modelId: "gpt-4o",
    };
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.type).toBe("run");
    expect(typeof parsed.runId).toBe("string");
    expect(typeof parsed.agentId).toBe("string");
    expect(parsed.context).toBeDefined();
  });

  it("cancel envelope", () => {
    const payload = { type: "cancel", runId: "r1" };
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("ack rejected envelope has required keys", () => {
    const payload = {
      type: "ack",
      runId: "r1",
      agentId: "a1",
      status: "rejected",
      code: "placement_mismatch",
    };
    const parsed = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(parsed.type).toBe("ack");
    expect(parsed.code).toBe("placement_mismatch");
    expect(parsed.runId).toBe("r1");
    expect(parsed.agentId).toBe("a1");
    expect(parsed.status).toBe("rejected");
  });

  it("status envelope has required keys", () => {
    const payload = {
      type: "status",
      runId: "r1",
      agentId: "a1",
      status: "running",
    };
    const parsed = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(parsed.type).toBe("status");
    expect(parsed.runId).toBe("r1");
    expect(parsed.agentId).toBe("a1");
    expect(parsed.status).toBe("running");
  });

  it("log envelope has required keys", () => {
    const payload = {
      type: "log",
      runId: "r1",
      agentId: "a1",
      stream: "stdout",
      chunk: "hi\n",
      ts: "2025-01-01T00:00:00Z",
    };
    const parsed = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(parsed.type).toBe("log");
    expect(parsed.runId).toBe("r1");
    expect(parsed.agentId).toBe("a1");
    expect(parsed.stream).toBe("stdout");
    expect(parsed.chunk).toBe("hi\n");
    expect(parsed.ts).toBe("2025-01-01T00:00:00Z");
  });
});
