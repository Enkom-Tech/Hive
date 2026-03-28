import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRuns,
  issues,
} from "@hive/db";
import type { AdapterSessionCodec } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import {
  DEFERRED_WAKE_CONTEXT_KEY,
  enrichWakeContextSnapshot,
  normalizeAgentNameKey,
  normalizeSessionParams,
  readNonEmptyString,
  truncateDisplayId,
  type WakeupOptions,
} from "./types.js";

export type ReleasePromoteDeps = {
  db: Db;
  getSessionCodec: (adapterType: string) => AdapterSessionCodec;
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
  startNextQueuedRunForAgent: (agentId: string) => Promise<Array<typeof heartbeatRuns.$inferSelect>>;
};

export async function releaseIssueExecutionAndPromote(
  deps: ReleasePromoteDeps,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<void> {
  const { db, getSessionCodec, publishLiveEvent, startNextQueuedRunForAgent } = deps;

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
