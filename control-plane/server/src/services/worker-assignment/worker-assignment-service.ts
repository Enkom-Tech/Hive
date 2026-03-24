import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, workerInstanceAgents, workerInstances } from "@hive/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logPlacementMetric } from "../../placement-metrics.js";
import { syncWorkerInstanceBindings } from "../../workers/worker-link-registry.js";
import { pickNextCircularId } from "./placement-pool.js";
import { workerInstanceLabelsAllowSandboxPosture } from "./sandbox-labels.js";

export type AssignmentSource = "manual" | "automatic";

function placementRequiredLabelsFromAdapterConfig(adapterConfig: unknown): Record<string, unknown> | null {
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) return null;
  const raw = (adapterConfig as Record<string, unknown>).placementRequiredLabels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

type AgentPlacementPolicyRow = {
  adapterConfig: unknown;
  operationalPosture: string | null;
};

async function listEligibleWorkerInstanceIds(
  db: Db,
  companyId: string,
  agentRow: AgentPlacementPolicyRow,
): Promise<string[]> {
  const required = placementRequiredLabelsFromAdapterConfig(agentRow.adapterConfig ?? null);
  const labelPredicate =
    required && Object.keys(required).length > 0
      ? sql`${workerInstances.labels}::jsonb @> ${JSON.stringify(required)}::jsonb`
      : undefined;

  const sandboxFilter =
    agentRow.operationalPosture === "sandbox"
      ? sql`${workerInstances.labels}::jsonb @> ${JSON.stringify({ sandbox: true })}::jsonb`
      : undefined;

  const parts = [
    eq(workerInstances.companyId, companyId),
    isNull(workerInstances.drainRequestedAt),
    labelPredicate,
    sandboxFilter,
  ].filter((x): x is NonNullable<typeof x> => x != null);

  const rows = await db
    .select({ id: workerInstances.id })
    .from(workerInstances)
    .where(and(...parts))
    .orderBy(asc(workerInstances.id));

  return rows.map((r) => r.id);
}

/** Prefer drones with fewer bound agents (tie-break: lowest internal id / lexical order). */
async function orderEligibleInstancesByBindingLoad(
  db: Db,
  companyId: string,
  baseOrderedIds: string[],
): Promise<string[]> {
  if (baseOrderedIds.length === 0) return [];
  const counts = await db
    .select({
      workerInstanceId: workerInstanceAgents.workerInstanceId,
      c: sql<number>`count(*)::int`,
    })
    .from(workerInstanceAgents)
    .where(inArray(workerInstanceAgents.workerInstanceId, baseOrderedIds))
    .groupBy(workerInstanceAgents.workerInstanceId);

  const loadById = new Map<string, number>();
  for (const id of baseOrderedIds) loadById.set(id, 0);
  for (const row of counts) {
    loadById.set(row.workerInstanceId, row.c);
  }

  return [...baseOrderedIds].sort((a, b) => {
    const la = loadById.get(a) ?? 0;
    const lb = loadById.get(b) ?? 0;
    if (la !== lb) return la - lb;
    return a.localeCompare(b);
  });
}

/**
 * Sole mutator for `worker_instance_agents` (ADR 005). Registry sync after each successful change.
 */
export function createWorkerAssignmentService(db: Db) {
  async function bindManagedWorkerAgentToInstance(
    companyId: string,
    workerInstanceId: string,
    agentId: string,
    assignmentSource: AssignmentSource = "manual",
  ): Promise<void> {
    const agentRow = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agentRow) throw notFound("Agent not found");
    if (agentRow.adapterType !== "managed_worker") {
      throw unprocessable("Only managed_worker agents can be bound to a worker instance");
    }
    if (agentRow.status === "terminated" || agentRow.status === "pending_approval") {
      throw conflict("Agent cannot be bound in current status");
    }
    if (agentRow.operationalPosture === "archived" || agentRow.operationalPosture === "hibernate") {
      throw conflict("Agent cannot be bound while archived or hibernating");
    }

    const inst = await db
      .select({ id: workerInstances.id, labels: workerInstances.labels })
      .from(workerInstances)
      .where(and(eq(workerInstances.id, workerInstanceId), eq(workerInstances.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!inst) throw notFound("Worker instance not found");

    if (agentRow.operationalPosture === "sandbox" && !workerInstanceLabelsAllowSandboxPosture(inst.labels)) {
      throw unprocessable(
        "Sandbox identities may only bind to drones whose labels include sandbox: true",
      );
    }

    const prev = await db
      .select({ workerInstanceId: workerInstanceAgents.workerInstanceId })
      .from(workerInstanceAgents)
      .where(eq(workerInstanceAgents.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    const now = new Date();
    await db
      .insert(workerInstanceAgents)
      .values({
        workerInstanceId,
        agentId,
        assignmentSource,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workerInstanceAgents.agentId,
        set: {
          workerInstanceId,
          assignmentSource,
          updatedAt: now,
        },
      });

    if (prev?.workerInstanceId && prev.workerInstanceId !== workerInstanceId) {
      await syncWorkerInstanceBindings(db, prev.workerInstanceId);
    }
    await syncWorkerInstanceBindings(db, workerInstanceId);

    await db
      .update(agents)
      .set({
        lastAutomaticPlacementFailure: null,
        lastAutomaticPlacementFailureAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  async function unbindManagedWorkerAgentFromInstance(companyId: string, agentId: string): Promise<void> {
    const agentRow = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agentRow) throw notFound("Agent not found");

    const prev = await db
      .select({ workerInstanceId: workerInstanceAgents.workerInstanceId })
      .from(workerInstanceAgents)
      .where(eq(workerInstanceAgents.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    if (!prev) return;

    await db.delete(workerInstanceAgents).where(eq(workerInstanceAgents.agentId, agentId));
    await syncWorkerInstanceBindings(db, prev.workerInstanceId);
  }

  /**
   * Pick a non-draining `worker_instances` row for the company (deterministic: lowest internal id).
   * Respects `adapterConfig.placementRequiredLabels` and sandbox posture when applicable.
   */
  async function tryAutomaticBindForAgent(agentId: string, companyId: string): Promise<boolean> {
    const agentRow = await db
      .select({
        status: agents.status,
        adapterConfig: agents.adapterConfig,
        operationalPosture: agents.operationalPosture,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((r) => r[0] ?? null);
    if (!agentRow) return false;
    if (agentRow.status === "terminated" || agentRow.status === "pending_approval") return false;
    if (agentRow.operationalPosture === "archived" || agentRow.operationalPosture === "hibernate") return false;

    const eligible = await listEligibleWorkerInstanceIds(db, companyId, agentRow);
    const ordered = await orderEligibleInstancesByBindingLoad(db, companyId, eligible);
    const first = ordered[0];
    if (!first) return false;

    await bindManagedWorkerAgentToInstance(companyId, first, agentId, "automatic");
    return true;
  }

  /**
   * Best-effort reconcile: assign unbound automatic managed_worker identities in this company.
   * Intended for triggers like new drone registration (provision hello) or policy changes.
   */
  async function reconcileAutomaticAssignmentsForCompany(companyId: string): Promise<{
    attempted: number;
    assigned: number;
  }> {
    const rows = await db
      .select({
        agentId: agents.id,
        workerPlacementMode: agents.workerPlacementMode,
        adapterType: agents.adapterType,
        status: agents.status,
        operationalPosture: agents.operationalPosture,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    let attempted = 0;
    let assigned = 0;
    for (const row of rows) {
      if (row.adapterType !== "managed_worker") continue;
      if (row.workerPlacementMode !== "automatic") continue;
      if (row.status === "terminated" || row.status === "pending_approval") continue;
      if (row.operationalPosture === "archived" || row.operationalPosture === "hibernate") continue;

      const hasBinding = await db
        .select({ agentId: workerInstanceAgents.agentId })
        .from(workerInstanceAgents)
        .where(eq(workerInstanceAgents.agentId, row.agentId))
        .limit(1)
        .then((r) => (r[0] ? true : false));
      if (hasBinding) continue;

      attempted += 1;
      const ok = await tryAutomaticBindForAgent(row.agentId, companyId);
      if (ok) {
        assigned += 1;
        logPlacementMetric("placement_mobility", {
          kind: "automatic_assign_reconcile",
          companyId,
          agentId: row.agentId,
        });
      } else {
        const now = new Date();
        await db
          .update(agents)
          .set({
            lastAutomaticPlacementFailure: "no_eligible_drone",
            lastAutomaticPlacementFailureAt: now,
            updatedAt: now,
          })
          .where(eq(agents.id, row.agentId));
      }
    }
    return { attempted, assigned };
  }

  /**
   * Advance automatic pool assignment to the next eligible drone (circular by internal id).
   * If unassigned, behaves like the first automatic bind when eligible drones exist.
   */
  async function rotateAutomaticPlacementToNextDrone(
    companyId: string,
    agentId: string,
  ): Promise<{
    rotated: boolean;
    fromWorkerInstanceId: string | null;
    toWorkerInstanceId: string | null;
  }> {
    const agentRow = await db
      .select({
        adapterType: agents.adapterType,
        status: agents.status,
        workerPlacementMode: agents.workerPlacementMode,
        adapterConfig: agents.adapterConfig,
        operationalPosture: agents.operationalPosture,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((r) => r[0] ?? null);
    if (!agentRow) throw notFound("Agent not found");
    if (agentRow.adapterType !== "managed_worker") {
      throw unprocessable("Only managed_worker agents support automatic pool rotation");
    }
    if (agentRow.workerPlacementMode !== "automatic") {
      throw unprocessable("Agent worker_placement_mode must be automatic to rotate pool placement");
    }
    if (agentRow.status === "terminated" || agentRow.status === "pending_approval") {
      throw conflict("Agent cannot rotate pool placement in current status");
    }
    if (agentRow.operationalPosture === "archived" || agentRow.operationalPosture === "hibernate") {
      throw conflict("Agent cannot rotate pool placement while archived or hibernating");
    }

    const eligible = await listEligibleWorkerInstanceIds(db, companyId, agentRow);
    if (eligible.length === 0) {
      throw unprocessable("No eligible non-draining drones match this agent's placement rules");
    }

    const binding = await db
      .select({ workerInstanceId: workerInstanceAgents.workerInstanceId })
      .from(workerInstanceAgents)
      .where(eq(workerInstanceAgents.agentId, agentId))
      .then((r) => r[0] ?? null);
    const currentId = binding?.workerInstanceId ?? null;

    if (currentId == null) {
      const ok = await tryAutomaticBindForAgent(agentId, companyId);
      if (!ok) {
        throw unprocessable("No eligible non-draining drones match this agent's placement rules");
      }
      const after = await db
        .select({ workerInstanceId: workerInstanceAgents.workerInstanceId })
        .from(workerInstanceAgents)
        .where(eq(workerInstanceAgents.agentId, agentId))
        .then((r) => r[0] ?? null);
      const toId = after?.workerInstanceId ?? null;
      logPlacementMetric("placement_mobility", {
        companyId,
        agentId,
        kind: "automatic_pool_rotate",
        fromWorkerInstanceId: null,
        toWorkerInstanceId: toId,
        initialBind: true,
      });
      return { rotated: true, fromWorkerInstanceId: null, toWorkerInstanceId: toId };
    }

    const nextId = pickNextCircularId(eligible, currentId);
    if (!nextId || nextId === currentId) {
      return { rotated: false, fromWorkerInstanceId: currentId, toWorkerInstanceId: currentId };
    }

    await bindManagedWorkerAgentToInstance(companyId, nextId, agentId, "automatic");
    logPlacementMetric("placement_mobility", {
      companyId,
      agentId,
      kind: "automatic_pool_rotate",
      fromWorkerInstanceId: currentId,
      toWorkerInstanceId: nextId,
      initialBind: false,
    });
    return { rotated: true, fromWorkerInstanceId: currentId, toWorkerInstanceId: nextId };
  }

  /**
   * After a drone is marked draining, rebind **automatic** `worker_instance_agents` rows to other eligible drones.
   * Manual bindings are left in place (operator must move them).
   */
  async function evacuateAutomaticAgentsOffDrainingInstance(
    companyId: string,
    drainingWorkerInstanceId: string,
  ): Promise<{ evacuatedAgentIds: string[]; skippedAgentIds: string[] }> {
    const bindings = await db
      .select({
        agentId: workerInstanceAgents.agentId,
        assignmentSource: workerInstanceAgents.assignmentSource,
      })
      .from(workerInstanceAgents)
      .where(eq(workerInstanceAgents.workerInstanceId, drainingWorkerInstanceId));

    const evacuatedAgentIds: string[] = [];
    const skippedAgentIds: string[] = [];

    for (const b of bindings) {
      if (b.assignmentSource !== "automatic") continue;

      const agentRow = await db
        .select({
          adapterType: agents.adapterType,
          status: agents.status,
          workerPlacementMode: agents.workerPlacementMode,
          adapterConfig: agents.adapterConfig,
          operationalPosture: agents.operationalPosture,
        })
        .from(agents)
        .where(and(eq(agents.id, b.agentId), eq(agents.companyId, companyId)))
        .then((r) => r[0] ?? null);

      if (!agentRow || agentRow.adapterType !== "managed_worker") {
        skippedAgentIds.push(b.agentId);
        continue;
      }
      if (agentRow.workerPlacementMode !== "automatic") continue;
      if (agentRow.status === "terminated" || agentRow.status === "pending_approval") {
        skippedAgentIds.push(b.agentId);
        continue;
      }

      const eligible = await listEligibleWorkerInstanceIds(db, companyId, agentRow);
      const nextId = pickNextCircularId(eligible, drainingWorkerInstanceId);
      if (!nextId) {
        skippedAgentIds.push(b.agentId);
        logPlacementMetric("placement_mobility", {
          kind: "drain_evacuate_skipped",
          companyId,
          agentId: b.agentId,
          reason: "no_eligible_target",
          drainingWorkerInstanceId,
        });
        continue;
      }

      await bindManagedWorkerAgentToInstance(companyId, nextId, b.agentId, "automatic");
      evacuatedAgentIds.push(b.agentId);
      logPlacementMetric("placement_mobility", {
        kind: "drain_evacuate",
        companyId,
        agentId: b.agentId,
        fromWorkerInstanceId: drainingWorkerInstanceId,
        toWorkerInstanceId: nextId,
      });
    }

    return { evacuatedAgentIds, skippedAgentIds };
  }

  return {
    bindManagedWorkerAgentToInstance,
    /** Same as bind with manual source — pool mobility / operator move (ADR 005). */
    moveManagedWorkerAgentToInstance: (
      companyId: string,
      workerInstanceId: string,
      agentId: string,
    ) => bindManagedWorkerAgentToInstance(companyId, workerInstanceId, agentId, "manual"),
    unbindManagedWorkerAgentFromInstance,
    tryAutomaticBindForAgent,
    reconcileAutomaticAssignmentsForCompany,
    rotateAutomaticPlacementToNextDrone,
    evacuateAutomaticAgentsOffDrainingInstance,
  };
}
