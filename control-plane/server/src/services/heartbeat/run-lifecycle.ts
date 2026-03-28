import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@hive/db";
import type { AdapterSessionCodec } from "../../adapters/index.js";
import { notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../../log-redaction.js";
import type { RunLogHandle } from "../run-log-store.js";
import { publishLiveEvent } from "../live-events.js";
import { normalizeSessionParams, readNonEmptyString, truncateDisplayId } from "./types.js";
import { createRunLifecycleListQueries } from "./run-lifecycle-list-queries.js";
import { isUuidFormattedRunId } from "./run-lifecycle-ids.js";
import { parseHeartbeatPolicy } from "./run-lifecycle-policy.js";
import { releaseIssueExecutionAndPromote as releaseIssueExecutionAndPromoteImpl } from "./run-lifecycle-release-promote.js";
import { createRunLifecycleCancelReap, type RunningProcessRef } from "./run-lifecycle-cancel-reap.js";
import { createRunLifecycleRunLog } from "./run-lifecycle-run-log.js";
import { createRunLifecycleQueue } from "./run-lifecycle-queue.js";
import { createRunLifecycleEnqueueWakeup } from "./run-lifecycle-enqueue-wakeup.js";

export type { RunningProcessRef };

export interface RunLifecycleDeps {
  db: Db;
  runLogStore: {
    read(handle: RunLogHandle, opts?: { offset?: number; limitBytes?: number }): Promise<{ content: string; nextOffset?: number }>;
    append(handle: RunLogHandle, event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string }): Promise<void>;
    finalize(handle: RunLogHandle): Promise<{ bytes: number; sha256?: string; compressed: boolean }>;
  };
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
  getSessionCodec: (adapterType: string) => AdapterSessionCodec;
  onRunClaimed?: (runId: string) => void;
  runningProcesses?: RunningProcessRef;
  sendCancelToWorker?: (agentId: string, runId: string) => void;
}

export function createRunLifecycle(deps: RunLifecycleDeps) {
  const { db, runLogStore, publishLiveEvent, getSessionCodec, onRunClaimed, runningProcesses, sendCancelToWorker } = deps;
  const { list, listEvents } = createRunLifecycleListQueries(db);
  const deferredRunLogHandles = new Map<string, RunLogHandle>();

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;
    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ): Promise<string | null> {
    if (taskKey) {
      const codec = getSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }
    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }
    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
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
  ) {
    const sanitizedMessage = event.message ? redactCurrentUserText(event.message) : event.message;
    const sanitizedPayload = event.payload ? redactCurrentUserValue(event.payload) : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  const {
    registerDeferredRunLogHandle,
    finalizeAndRemoveRunLogHandle,
    getNextRunEventSeq,
    appendWorkerRunLog,
    readLog,
  } = createRunLifecycleRunLog({
    db,
    runLogStore,
    deferredRunLogHandles,
    getRun,
    publishLiveEvent,
  });

  const { countRunningRunsForAgent, claimQueuedRun, startNextQueuedRunForAgent } = createRunLifecycleQueue({
    db,
    publishLiveEvent,
    onRunClaimed,
    getAgent,
    setWakeupStatus,
  });

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;
    if (existing.status === "paused" || existing.status === "terminated") return;

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt ? new Date(updated.lastHeartbeatAt).toISOString() : null,
          outcome,
        },
      });
    }
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    if (opts?.adapterType) conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }
    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect): Promise<void> {
    await releaseIssueExecutionAndPromoteImpl(
      { db, getSessionCodec, publishLiveEvent, startNextQueuedRunForAgent },
      run,
    );
  }

  const { reapOrphanedRuns, cancelRun, cancelActiveForAgent } = createRunLifecycleCancelReap({
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
  });

  const { enqueueWakeup } = createRunLifecycleEnqueueWakeup({
    db,
    publishLiveEvent,
    getAgent,
    resolveSessionBeforeForWakeup,
    startNextQueuedRunForAgent,
  });

  async function touchRun(runId: string): Promise<boolean> {
    const run = await getRun(runId);
    if (!run) return false;
    await db
      .update(heartbeatRuns)
      .set({ updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    return true;
  }

  async function finishRunForIssueClosure(
    runId: string,
    issueStatus: "done" | "cancelled",
  ): Promise<(typeof heartbeatRuns.$inferSelect) | null> {
    const run = await getRun(runId);
    if (!run) return null;
    if (run.status !== "queued" && run.status !== "running") return run;
    const runStatus = issueStatus === "done" ? "succeeded" : "cancelled";
    return setRunStatus(runId, runStatus, {
      finishedAt: new Date(),
      error: null,
      errorCode: null,
    });
  }

  async function ensureExternalRunForCheckout(
    companyId: string,
    agentId: string,
    runId: string,
    issueId: string,
  ): Promise<(typeof heartbeatRuns.$inferSelect) | null> {
    if (!isUuidFormattedRunId(runId)) return null;
    const existing = await getRun(runId);
    if (existing) return existing;
    const now = new Date();
    const [inserted] = await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "external_agent_checkout",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return inserted ?? null;
  }

  async function getActiveRunForAgent(agentId: string) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")),
      )
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(1);
    return run ?? null;
  }

  async function getRuntimeStateEnriched(agentId: string) {
    const state = await getRuntimeState(agentId);
    const agent = await getAgent(agentId);
    if (!agent) return null;
    const ensured = state ?? (await ensureRuntimeState(agent));
    const latestTaskSession = await db
      .select()
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
      .orderBy(desc(agentTaskSessions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return {
      ...ensured,
      sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
      sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
    };
  }

  async function listTaskSessions(agentId: string) {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    return db
      .select()
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
      .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
  }

  async function resetRuntimeSession(agentId: string, opts?: { taskKey?: string | null }) {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    await ensureRuntimeState(agent);
    const taskKey = readNonEmptyString(opts?.taskKey);
    const clearedTaskSessions = await clearTaskSessions(
      agent.companyId,
      agent.id,
      taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
    );
    const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
      sessionId: null,
      lastError: null,
      updatedAt: new Date(),
    };
    if (!taskKey) {
      runtimePatch.stateJson = {};
    }

    const updated = await db
      .update(agentRuntimeState)
      .set(runtimePatch)
      .where(eq(agentRuntimeState.agentId, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!updated) return null;
    return {
      ...updated,
      sessionDisplayId: null,
      sessionParamsJson: null,
      clearedTaskSessions,
    };
  }

  return {
    registerDeferredRunLogHandle,
    finalizeAndRemoveRunLogHandle,
    getNextRunEventSeq,
    appendWorkerRunLog,
    getRun,
    getAgent,
    setRunStatus,
    setWakeupStatus,
    appendRunEvent,
    claimQueuedRun,
    touchRun,
    list,
    listEvents,
    readLog,
    finishRunForIssueClosure,
    ensureExternalRunForCheckout,
    reapOrphanedRuns,
    startNextQueuedRunForAgent,
    releaseIssueExecutionAndPromote,
    enqueueWakeup,
    cancelRun,
    cancelActiveForAgent,
    getActiveRunForAgent,
    finalizeAgentStatus,
    getRuntimeState: getRuntimeStateEnriched,
    listTaskSessions,
    resetRuntimeSession,
    ensureRuntimeState,
    resolveSessionBeforeForWakeup,
    parseHeartbeatPolicy,
    upsertTaskSession,
    getTaskSession,
    clearTaskSessions,
  };
}
