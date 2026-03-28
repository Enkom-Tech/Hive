import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentWakeupRequests, agents, heartbeatRuns } from "@hive/db";
import { parseHeartbeatPolicy } from "./run-lifecycle-policy.js";

export type RunLifecycleQueueDeps = {
  db: Db;
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
  onRunClaimed?: (runId: string) => void;
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null>;
  setWakeupStatus: (
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) => Promise<void>;
};

export function createRunLifecycleQueue(deps: RunLifecycleQueueDeps) {
  const { db, publishLiveEvent, onRunClaimed, getAgent, setWakeupStatus } = deps;
  const startLocksByAgent = new Map<string, Promise<void>>();

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

  return {
    countRunningRunsForAgent,
    claimQueuedRun,
    startNextQueuedRunForAgent,
  };
}
