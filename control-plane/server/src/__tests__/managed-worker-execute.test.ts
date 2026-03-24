import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@hive/db";
import { getManagedWorkerExecuteDeps } from "../adapters/managed-worker/execute-deps.js";
import {
  insertPendingRunPlacement,
  isWorkerInstanceDraining,
  markRunPlacementActive,
  markRunPlacementFailed,
  resolveAgentWorkerBinding,
  schedulePlacementDispatchRetry,
  workerInstanceAllowsSandboxPosture,
} from "../services/placement.js";
import { getWorkerLinkStableInstanceId, sendRunToWorker } from "../workers/worker-link.js";
import { execute } from "../adapters/managed-worker/execute.js";

vi.mock("../workers/worker-link.js", () => ({
  sendRunToWorker: vi.fn(),
  getWorkerLinkStableInstanceId: vi.fn(),
}));

vi.mock("../adapters/managed-worker/execute-deps.js", () => ({
  getManagedWorkerExecuteDeps: vi.fn(() => null),
  setManagedWorkerExecuteDeps: vi.fn(),
}));

vi.mock("../services/placement.js", () => ({
  resolveAgentWorkerBinding: vi.fn(),
  isWorkerInstanceDraining: vi.fn(),
  insertPendingRunPlacement: vi.fn(),
  markRunPlacementActive: vi.fn(),
  markRunPlacementFailed: vi.fn(),
  schedulePlacementDispatchRetry: vi.fn(() => Promise.resolve({ scheduled: false as const })),
  workerInstanceAllowsSandboxPosture: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../placement-metrics.js", () => ({
  logPlacementMetric: vi.fn(),
}));

describe("managed-worker execute", () => {
  const mockDb = {} as Db;
  const stableUuid = "550e8400-e29b-41d4-a716-446655440000";

  const mockContext = {
    runId: "run-123",
    agent: {
      id: "agent-456",
      companyId: "company-1",
      name: "Test",
      adapterType: "managed_worker",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "task-1",
    },
    config: { timeoutMs: 5000 },
    context: { taskKey: "task-1" },
    onLog: vi.fn(),
    onMeta: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(sendRunToWorker).mockReset();
    vi.mocked(sendRunToWorker).mockReturnValue(false);
    vi.mocked(getWorkerLinkStableInstanceId).mockReturnValue(undefined);
    vi.mocked(getManagedWorkerExecuteDeps).mockReturnValue(null);
    vi.mocked(resolveAgentWorkerBinding).mockResolvedValue(null);
    vi.mocked(isWorkerInstanceDraining).mockResolvedValue(false);
    vi.mocked(insertPendingRunPlacement).mockReset();
    vi.mocked(markRunPlacementActive).mockReset();
    vi.mocked(markRunPlacementFailed).mockReset();
    vi.mocked(schedulePlacementDispatchRetry).mockReset();
    vi.mocked(schedulePlacementDispatchRetry).mockResolvedValue({ scheduled: false });
    vi.mocked(workerInstanceAllowsSandboxPosture).mockReset();
    vi.mocked(workerInstanceAllowsSandboxPosture).mockResolvedValue(true);
  });

  it("returns failed result when no worker is connected", async () => {
    vi.mocked(sendRunToWorker).mockReturnValue(false);

    const result = await execute(mockContext as Parameters<typeof execute>[0]);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("No worker connected for this agent");
    expect(result.errorCode).toBe("NO_WORKER");
    expect(result.completionDeferred).toBe(false);
    expect(sendRunToWorker).toHaveBeenCalledTimes(1);
    expect(sendRunToWorker).toHaveBeenCalledWith("agent-456", {
      type: "run",
      runId: "run-123",
      agentId: "agent-456",
      adapterKey: undefined,
      context: { taskKey: "task-1" },
    });
  });

  it("returns success with completionDeferred when worker is connected", async () => {
    vi.mocked(sendRunToWorker).mockReturnValue(true);

    const result = await execute(mockContext as Parameters<typeof execute>[0]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("Run dispatched to worker");
    expect(result.completionDeferred).toBe(true);
    expect(sendRunToWorker).toHaveBeenCalledTimes(1);
    expect(sendRunToWorker).toHaveBeenCalledWith("agent-456", {
      type: "run",
      runId: "run-123",
      agentId: "agent-456",
      adapterKey: undefined,
      context: { taskKey: "task-1" },
    });
  });

  it("passes adapterKey when present in context", async () => {
    vi.mocked(sendRunToWorker).mockReturnValue(true);
    const result = await execute({
      ...mockContext,
      adapterKey: "codex_acp",
    } as Parameters<typeof execute>[0]);
    expect(result.completionDeferred).toBe(true);
    expect(sendRunToWorker).toHaveBeenCalledWith("agent-456", {
      type: "run",
      runId: "run-123",
      agentId: "agent-456",
      adapterKey: "codex_acp",
      context: { taskKey: "task-1" },
    });
  });

  describe("placement v1", () => {
    beforeEach(() => {
      vi.mocked(getManagedWorkerExecuteDeps).mockReturnValue({
        db: mockDb,
        placementV1Enabled: true,
        autoPlacementEnabled: false,
        loadAgentSchedulingRow: async () => ({
          workerPlacementMode: "manual",
          operationalPosture: "active",
          status: "idle",
        }),
      });
      vi.mocked(resolveAgentWorkerBinding).mockResolvedValue({
        workerInstanceRowId: "wi-row-1",
        stableInstanceId: stableUuid,
      });
      vi.mocked(isWorkerInstanceDraining).mockResolvedValue(false);
      vi.mocked(insertPendingRunPlacement).mockResolvedValue("placement-p1");
      vi.mocked(markRunPlacementActive).mockResolvedValue(undefined);
      vi.mocked(markRunPlacementFailed).mockResolvedValue(undefined);
    });

    it("includes placement fields and marks active when binding exists and worker connected", async () => {
      vi.mocked(sendRunToWorker).mockReturnValue(true);
      vi.mocked(getWorkerLinkStableInstanceId).mockReturnValue(undefined);

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.completionDeferred).toBe(true);
      expect(insertPendingRunPlacement).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          heartbeatRunId: "run-123",
          companyId: "company-1",
          agentId: "agent-456",
          workerInstanceId: "wi-row-1",
        }),
      );
      expect(sendRunToWorker).toHaveBeenCalledWith(
        "agent-456",
        expect.objectContaining({
          type: "run",
          runId: "run-123",
          placementId: "placement-p1",
          expectedWorkerInstanceId: stableUuid,
        }),
      );
      expect(markRunPlacementActive).toHaveBeenCalledWith(mockDb, "placement-p1");
    });

    it("fails before insert when link stable id disagrees with board binding", async () => {
      vi.mocked(getWorkerLinkStableInstanceId).mockReturnValue("00000000-0000-0000-0000-000000000099");
      vi.mocked(sendRunToWorker).mockReturnValue(true);

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.errorCode).toBe("PLACEMENT_CONNECTION_MISMATCH");
      expect(result.exitCode).toBe(1);
      expect(insertPendingRunPlacement).not.toHaveBeenCalled();
      expect(sendRunToWorker).not.toHaveBeenCalled();
    });

    it("allows dispatch when link stable id matches binding (case-insensitive)", async () => {
      vi.mocked(getWorkerLinkStableInstanceId).mockReturnValue(stableUuid.toUpperCase());
      vi.mocked(sendRunToWorker).mockReturnValue(true);

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.completionDeferred).toBe(true);
      expect(insertPendingRunPlacement).toHaveBeenCalled();
      expect(sendRunToWorker).toHaveBeenCalled();
    });

    it("returns DRAINING when instance is draining", async () => {
      vi.mocked(isWorkerInstanceDraining).mockResolvedValue(true);

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.errorCode).toBe("DRAINING");
      expect(insertPendingRunPlacement).not.toHaveBeenCalled();
      expect(sendRunToWorker).not.toHaveBeenCalled();
    });

    it("marks placement failed when worker not connected after insert", async () => {
      vi.mocked(sendRunToWorker).mockReturnValue(false);

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.errorCode).toBe("NO_WORKER");
      expect(markRunPlacementFailed).toHaveBeenCalledWith(mockDb, "placement-p1", "NOT_CONNECTED");
    });

    it("schedules placement retry and requeues when dispatch retry is available", async () => {
      vi.mocked(sendRunToWorker).mockReturnValue(false);
      vi.mocked(schedulePlacementDispatchRetry).mockResolvedValue({
        scheduled: true,
        nextAttemptAt: new Date("2030-01-01T00:00:00.000Z"),
      });

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.requeueRun).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(schedulePlacementDispatchRetry).toHaveBeenCalledWith(mockDb, "placement-p1");
      expect(markRunPlacementFailed).not.toHaveBeenCalled();
    });

    it("fails with SANDBOX_BINDING_MISMATCH when posture is sandbox and drone labels do not qualify", async () => {
      vi.mocked(getManagedWorkerExecuteDeps).mockReturnValue({
        db: mockDb,
        placementV1Enabled: true,
        autoPlacementEnabled: false,
        loadAgentSchedulingRow: async () => ({
          workerPlacementMode: "manual",
          operationalPosture: "sandbox",
          status: "idle",
        }),
      });
      vi.mocked(workerInstanceAllowsSandboxPosture).mockResolvedValue(false);
      vi.mocked(sendRunToWorker).mockReturnValue(true);

      const result = await execute(mockContext as Parameters<typeof execute>[0]);

      expect(result.errorCode).toBe("SANDBOX_BINDING_MISMATCH");
      expect(result.exitCode).toBe(1);
      expect(insertPendingRunPlacement).not.toHaveBeenCalled();
      expect(sendRunToWorker).not.toHaveBeenCalled();
    });
  });
});
