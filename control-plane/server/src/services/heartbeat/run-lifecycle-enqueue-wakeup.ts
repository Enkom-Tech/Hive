import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@hive/db";
import { parseObject } from "../../adapters/utils.js";
import { conflict, notFound } from "../../errors.js";
import { parseHeartbeatPolicy } from "./run-lifecycle-policy.js";
import {
  DEFERRED_WAKE_CONTEXT_KEY,
  enrichWakeContextSnapshot,
  isSameTaskScope,
  mergeCoalescedContextSnapshot,
  normalizeAgentNameKey,
  readNonEmptyString,
  runTaskKey,
  type WakeupOptions,
} from "./types.js";

export type RunLifecycleEnqueueWakeupDeps = {
  db: Db;
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null>;
  resolveSessionBeforeForWakeup: (
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) => Promise<string | null>;
  startNextQueuedRunForAgent: (agentId: string) => Promise<Array<typeof heartbeatRuns.$inferSelect>>;
};

export function createRunLifecycleEnqueueWakeup(deps: RunLifecycleEnqueueWakeupDeps) {
  const { db, publishLiveEvent, getAgent, resolveSessionBeforeForWakeup, startNextQueuedRunForAgent } = deps;
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

  return { enqueueWakeup };
}
