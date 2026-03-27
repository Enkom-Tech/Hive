import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, heartbeatRuns, runPlacements, workerInstanceAgents, workerInstances } from "@hive/db";
import { workerInstanceLabelsAllowSandboxPosture } from "./worker-assignment/sandbox-labels.js";

/** Bindings are written only via `createWorkerAssignmentService` / board APIs (ADR 005). Registry sync runs after each mutation. */

export type AgentWorkerBinding = {
  workerInstanceRowId: string;
  stableInstanceId: string;
};

/** Max failed dispatch attempts before terminal NOT_CONNECTED (placement v1). */
export const PLACEMENT_DISPATCH_MAX_ATTEMPTS = 8;

export function computePlacementRetryDelayMs(dispatchAttemptCountAfterIncrement: number): number {
  const cappedExp = Math.min(dispatchAttemptCountAfterIncrement, 6);
  const base = Math.min(60_000, 1000 * 2 ** cappedExp);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/**
 * When a pending placement cannot dispatch (e.g. worker socket not on this replica), schedule
 * `next_attempt_at` and increment `dispatch_attempt_count`. Returns scheduled=false when cap hit.
 */
export async function schedulePlacementDispatchRetry(
  db: Db,
  placementId: string,
): Promise<{ scheduled: boolean; nextAttemptAt?: Date }> {
  return db.transaction(async (tx) => {
    const row = await tx
      .select({
        state: runPlacements.state,
        dispatchAttemptCount: runPlacements.dispatchAttemptCount,
      })
      .from(runPlacements)
      .where(eq(runPlacements.id, placementId))
      .then((r) => r[0] ?? null);
    if (!row || row.state !== "pending") return { scheduled: false };
    const nextCount = row.dispatchAttemptCount + 1;
    if (nextCount >= PLACEMENT_DISPATCH_MAX_ATTEMPTS) return { scheduled: false };
    const delayMs = computePlacementRetryDelayMs(nextCount);
    const nextAttemptAt = new Date(Date.now() + delayMs);
    await tx
      .update(runPlacements)
      .set({
        dispatchAttemptCount: nextCount,
        nextAttemptAt,
      })
      .where(and(eq(runPlacements.id, placementId), eq(runPlacements.state, "pending")));
    return { scheduled: true, nextAttemptAt };
  });
}

/** If the run is queued but placement backoff is still in the future, heartbeat should not claim it yet. */
export async function queuedRunHasFuturePlacementBackoff(db: Db, heartbeatRunId: string): Promise<boolean> {
  const row = await db
    .select({ id: runPlacements.id })
    .from(runPlacements)
    .where(
      and(
        eq(runPlacements.heartbeatRunId, heartbeatRunId),
        eq(runPlacements.state, "pending"),
        isNotNull(runPlacements.nextAttemptAt),
        gt(runPlacements.nextAttemptAt, new Date()),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);
  return row != null;
}

export type DuePlacementRetryRow = { heartbeatRunId: string };

/** Pending placements whose backoff elapsed and whose run is still queued (for sweeper). */
export async function listDuePlacementRetries(db: Db, limit = 25): Promise<DuePlacementRetryRow[]> {
  const now = new Date();
  return db
    .select({ heartbeatRunId: runPlacements.heartbeatRunId })
    .from(runPlacements)
    .innerJoin(heartbeatRuns, eq(runPlacements.heartbeatRunId, heartbeatRuns.id))
    .where(
      and(
        eq(runPlacements.state, "pending"),
        isNotNull(runPlacements.nextAttemptAt),
        lte(runPlacements.nextAttemptAt, now),
        eq(heartbeatRuns.status, "queued"),
      ),
    )
    .limit(limit);
}

function placementRequiredLabelsFromAdapterConfig(adapterConfig: unknown): Record<string, unknown> | null {
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) return null;
  const raw = (adapterConfig as Record<string, unknown>).placementRequiredLabels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export async function workerInstanceAllowsSandboxPosture(db: Db, workerInstanceRowId: string): Promise<boolean> {
  const row = await db
    .select({ labels: workerInstances.labels })
    .from(workerInstances)
    .where(eq(workerInstances.id, workerInstanceRowId))
    .limit(1)
    .then((r) => r[0] ?? null);
  return workerInstanceLabelsAllowSandboxPosture(row?.labels);
}

export async function resolveAgentWorkerBinding(db: Db, agentId: string): Promise<AgentWorkerBinding | null> {
  const agentRow = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0] ?? null);
  const required = placementRequiredLabelsFromAdapterConfig(agentRow?.adapterConfig ?? null);

  const labelPredicate =
    required && Object.keys(required).length > 0
      ? sql`${workerInstances.labels}::jsonb @> ${JSON.stringify(required)}::jsonb`
      : undefined;

  const row = await db
    .select({
      wid: workerInstances.id,
      stable: workerInstances.stableInstanceId,
    })
    .from(workerInstanceAgents)
    .innerJoin(workerInstances, eq(workerInstanceAgents.workerInstanceId, workerInstances.id))
    .where(
      labelPredicate
        ? and(eq(workerInstanceAgents.agentId, agentId), labelPredicate)
        : eq(workerInstanceAgents.agentId, agentId),
    )
    /** One row per agent PK; `ORDER BY` documents deterministic tie-break if constraints change. */
    .orderBy(asc(workerInstances.id))
    .limit(1)
    .then((r) => r[0] ?? null);
  if (!row) return null;
  const stable = typeof row.stable === "string" ? row.stable.trim() : "";
  if (!stable) return null;
  return { workerInstanceRowId: row.wid, stableInstanceId: stable };
}

export async function isWorkerInstanceDraining(db: Db, workerInstanceRowId: string): Promise<boolean> {
  const r = await db
    .select({ d: workerInstances.drainRequestedAt })
    .from(workerInstances)
    .where(eq(workerInstances.id, workerInstanceRowId))
    .then((x) => x[0] ?? null);
  return r?.d != null;
}

export async function insertPendingRunPlacement(
  db: Db,
  input: {
    heartbeatRunId: string;
    companyId: string;
    agentId: string;
    workerInstanceId: string;
    policyVersion?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(runPlacements)
    .values({
      heartbeatRunId: input.heartbeatRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      workerInstanceId: input.workerInstanceId,
      state: "pending",
      policyVersion: input.policyVersion ?? null,
    })
    .returning({ id: runPlacements.id });
  if (!row) throw new Error("insert run_placements failed");
  return row.id;
}

export async function markRunPlacementActive(db: Db, placementId: string): Promise<void> {
  const now = new Date();
  await db
    .update(runPlacements)
    .set({ state: "active", activatedAt: now, nextAttemptAt: null })
    .where(and(eq(runPlacements.id, placementId), eq(runPlacements.state, "pending")));
}

export async function markRunPlacementFailed(
  db: Db,
  placementId: string,
  failureCode: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(runPlacements)
    .set({ state: "failed", failureCode, completedAt: now })
    .where(eq(runPlacements.id, placementId));
}

/** Fail placement for a run when rejecting from worker (pending or active). */
export async function markRunPlacementFailedForHeartbeatRun(
  db: Db,
  heartbeatRunId: string,
  failureCode: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(runPlacements)
    .set({ state: "failed", failureCode, completedAt: now })
    .where(eq(runPlacements.heartbeatRunId, heartbeatRunId));
}

export async function markRunPlacementTerminalCompleted(db: Db, heartbeatRunId: string): Promise<void> {
  const now = new Date();
  await db
    .update(runPlacements)
    .set({ state: "completed", completedAt: now })
    .where(
      and(
        eq(runPlacements.heartbeatRunId, heartbeatRunId),
        eq(runPlacements.state, "active"),
      ),
    );
}

/** Runs tied to this worker instance with pending/active placement and non-terminal heartbeat status. */
export async function listPlacedHeartbeatRunsForWorkerInstance(
  db: Db,
  workerInstanceId: string,
): Promise<{ heartbeatRunId: string; agentId: string }[]> {
  return db
    .select({
      heartbeatRunId: runPlacements.heartbeatRunId,
      agentId: runPlacements.agentId,
    })
    .from(runPlacements)
    .innerJoin(heartbeatRuns, eq(runPlacements.heartbeatRunId, heartbeatRuns.id))
    .where(
      and(
        eq(runPlacements.workerInstanceId, workerInstanceId),
        inArray(runPlacements.state, ["pending", "active"]),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ),
    );
}
