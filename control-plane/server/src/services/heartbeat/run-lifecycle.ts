import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@hive/db";
import type { AdapterSessionCodec } from "../../adapters/index.js";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { conflict, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../../log-redaction.js";
import type { RunLogHandle } from "../run-log-store.js";
import { publishLiveEvent } from "../live-events.js";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import {
  DEFERRED_WAKE_CONTEXT_KEY,
  isExternalRun,
  isSameTaskScope,
  mergeCoalescedContextSnapshot,
  normalizeAgentNameKey,
  normalizeMaxConcurrentRuns,
  normalizeSessionParams,
  readNonEmptyString,
  runTaskKey,
  truncateDisplayId,
  enrichWakeContextSnapshot,
  type WakeupOptions,
} from "./types.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

export interface RunningProcessRef {
  get(runId: string): { child: { kill(signal: string): void; killed?: boolean }; graceSec: number } | undefined;
  has(runId: string): boolean;
  delete(runId: string): void;
}

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
  const startLocksByAgent = new Map<string, Promise<void>>();
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

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);
    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
    const run = previous.then(fn);
    const marker = run.then(
      () => undefined,
      () => undefined,
    );
    startLocksByAgent.set(agentId, marker);
    try {
      return await run;
    } finally {
      if (startLocksByAgent.get(agentId) === marker) {
        startLocksByAgent.delete(agentId);
      }
    }
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

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

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

  async function startNextQueuedRunForAgent(agentId: string): Promise<Array<typeof heartbeatRuns.$inferSelect>> {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) {
          claimedRuns.push(claimed);
          onRunClaimed?.(claimed.id);
        }
      }
      return claimedRuns;
    });
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect): Promise<void> {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return null;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource = (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail = (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = { ...deferredPayload };
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: { ...deferredContextSeed },
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore = await (async () => {
          if (promotedTaskKey) {
            const codec = getSessionCodec(deferredAgent.adapterType);
            const existingTaskSession = await tx
              .select()
              .from(agentTaskSessions)
              .where(
                and(
                  eq(agentTaskSessions.companyId, deferredAgent.companyId),
                  eq(agentTaskSessions.agentId, deferredAgent.id),
                  eq(agentTaskSessions.adapterType, deferredAgent.adapterType),
                  eq(agentTaskSessions.taskKey, promotedTaskKey),
                ),
              )
              .then((rows) => rows[0] ?? null);
            const parsedParams = normalizeSessionParams(
              codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
            );
            return truncateDisplayId(
              existingTaskSession?.sessionDisplayId ??
                (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
                readNonEmptyString(parsedParams?.sessionId),
            );
          }
          const runtimeForRun = await tx
            .select()
            .from(agentRuntimeState)
            .where(eq(agentRuntimeState.agentId, deferredAgent.id))
            .then((rows) => rows[0] ?? null);
          return runtimeForRun?.sessionId ?? null;
        })();

        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);
    const writeSkippedRequest = async (skipReason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, issue.executionRunId))
              .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ?? normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ?? (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

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
    if (!UUID_REGEX.test(runId)) return null;
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

  function registerDeferredRunLogHandle(runId: string, handle: RunLogHandle) {
    deferredRunLogHandles.set(runId, handle);
  }

  async function finalizeAndRemoveRunLogHandle(
    runId: string,
  ): Promise<{ bytes: number; sha256?: string; compressed: boolean } | null> {
    const handle = deferredRunLogHandles.get(runId);
    if (!handle) return null;
    try {
      const summary = await runLogStore.finalize(handle);
      return summary;
    } finally {
      deferredRunLogHandles.delete(runId);
    }
  }

  async function getNextRunEventSeq(runId: string): Promise<number> {
    const rows = await db
      .select({ m: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0)` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return (rows[0]?.m ?? 0) + 1;
  }

  const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

  async function appendWorkerRunLog(
    runId: string,
    stream: "stdout" | "stderr",
    chunk: string,
    ts: string,
  ): Promise<void> {
    const handle = deferredRunLogHandles.get(runId);
    if (!handle) return;
    const sanitized = redactCurrentUserText(chunk);
    await runLogStore.append(handle, { stream, chunk: sanitized, ts });
    const run = await getRun(runId);
    if (run) {
      const payloadChunk =
        sanitized.length > MAX_LIVE_LOG_CHUNK_BYTES
          ? sanitized.slice(sanitized.length - MAX_LIVE_LOG_CHUNK_BYTES)
          : sanitized;
      publishLiveEvent({
        companyId: run.companyId,
        type: "heartbeat.run.log",
        payload: {
          runId: run.id,
          agentId: run.agentId,
          ts,
          stream,
          chunk: payloadChunk,
          truncated: payloadChunk.length !== sanitized.length,
        },
      });
    }
  }

  async function readLog(runId: string, opts?: { offset?: number; limitBytes?: number }) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (!run.logStore || !run.logRef) throw notFound("Run log not found");

    const result = await runLogStore.read(
      {
        store: run.logStore as "local_file",
        logRef: run.logRef,
      },
      opts,
    );

    return {
      runId,
      store: run.logStore,
      logRef: run.logRef,
      ...result,
      content: redactCurrentUserText(result.content),
    };
  }

  const list = async (companyId: string, agentId?: string, limit?: number) => {
    const query = db
      .select(heartbeatRunListColumns)
      .from(heartbeatRuns)
      .where(
        agentId
          ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
          : eq(heartbeatRuns.companyId, companyId),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const rows = limit ? await query.limit(limit) : await query;
    return rows.map((row) => ({
      ...row,
      resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
    }));
  };

  const listEvents = (runId: string, afterSeq = 0, limit = 200) =>
    db
      .select()
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
      .orderBy(asc(heartbeatRunEvents.seq))
      .limit(Math.max(1, Math.min(limit, 1000)));

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
