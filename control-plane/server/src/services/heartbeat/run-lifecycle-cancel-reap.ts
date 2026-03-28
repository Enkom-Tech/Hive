import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentWakeupRequests, agents, heartbeatRuns } from "@hive/db";
import { notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { isExternalRun } from "./types.js";

/** Matches in-memory child process tracking for local adapter runs. */
export type RunningProcessRef = {
  get(runId: string): { child: { kill(signal: string): void; killed?: boolean }; graceSec: number } | undefined;
  has(runId: string): boolean;
  delete(runId: string): void;
};

export type RunLifecycleCancelReapDeps = {
  db: Db;
  runningProcesses?: RunningProcessRef;
  sendCancelToWorker?: (agentId: string, runId: string) => void;
  getRun: (runId: string) => Promise<typeof heartbeatRuns.$inferSelect | null>;
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null>;
  setRunStatus: (
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) => Promise<typeof heartbeatRuns.$inferSelect | null>;
  setWakeupStatus: (
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) => Promise<void>;
  appendRunEvent: (
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: typeof heartbeatRuns.$inferSelect) => Promise<void>;
  finalizeAgentStatus: (
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) => Promise<void>;
  startNextQueuedRunForAgent: (agentId: string) => Promise<Array<typeof heartbeatRuns.$inferSelect>>;
};

export function createRunLifecycleCancelReap(deps: RunLifecycleCancelReapDeps) {
  const {
    db,
    runningProcesses,
    sendCancelToWorker,
    getRun,
    getAgent,
    setRunStatus,
    setWakeupStatus,
    appendRunEvent,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    startNextQueuedRunForAgent,
  } = deps;

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));

    const reaped: string[] = [];

    for (const run of activeRuns) {
      if (runningProcesses?.has(run.id)) continue;
      if (isExternalRun(run)) continue;

      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      await setRunStatus(run.id, "failed", {
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: "Process lost -- server may have restarted",
      });
      const updatedRun = await getRun(run.id);
      if (updatedRun) {
        await appendRunEvent(updatedRun, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: "Process lost -- server may have restarted",
        });
        await releaseIssueExecutionAndPromote(updatedRun);
      }
      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses?.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function cancelRun(runId: string) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const agent = await getAgent(run.agentId);
    if (agent?.adapterType === "managed_worker") {
      sendCancelToWorker?.(run.agentId, run.id);
    }

    const running = runningProcesses?.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      const graceMs = Math.max(1, running.graceSec) * 1000;
      setTimeout(() => {
        if (!running.child.killed) {
          running.child.kill("SIGKILL");
        }
      }, graceMs);
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: "Cancelled by control plane",
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: "Cancelled by control plane",
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses?.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveForAgent(agentId: string) {
    const agent = await getAgent(agentId);
    const isManagedWorker = agent?.adapterType === "managed_worker";

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      if (isManagedWorker) {
        sendCancelToWorker?.(agentId, run.id);
      }
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled due to agent pause",
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled due to agent pause",
      });

      const running = runningProcesses?.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        runningProcesses?.delete(run.id);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  return { reapOrphanedRuns, cancelRun, cancelActiveForAgent };
}
