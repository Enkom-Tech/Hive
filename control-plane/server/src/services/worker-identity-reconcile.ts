import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, workerIdentityDesiredSlots } from "@hive/db";

export type WorkerIdentityReconcileBatchResult = {
  companyId: string;
  slotsProcessed: number;
  agentsCreated: number;
  errors: string[];
};

/**
 * Ensures each enabled desired-state slot has up to `desired_count` non-terminated managed_worker rows.
 * Does not delete or archive agents when counts exceed desired (scale-down stays manual).
 */
export async function reconcileWorkerIdentitySlotsForCompany(
  db: Db,
  companyId: string,
  opts: {
    enabled: boolean;
    createAgentFromSlot: (args: {
      companyId: string;
      slot: typeof workerIdentityDesiredSlots.$inferSelect;
    }) => Promise<{ id: string }>;
  },
): Promise<WorkerIdentityReconcileBatchResult> {
  if (!opts.enabled) {
    return { companyId, slotsProcessed: 0, agentsCreated: 0, errors: [] };
  }

  const slots = await db
    .select()
    .from(workerIdentityDesiredSlots)
    .where(and(eq(workerIdentityDesiredSlots.companyId, companyId), eq(workerIdentityDesiredSlots.enabled, true)));

  let agentsCreated = 0;
  const errors: string[] = [];
  let slotsProcessed = 0;

  for (const slot of slots) {
    slotsProcessed += 1;
    const desired = slot.desiredCount;
    if (desired <= 0) {
      await db
        .update(workerIdentityDesiredSlots)
        .set({
          lastReconciledAt: new Date(),
          lastReconcileError: null,
          lastReconcileSummary: { note: "desired_count_zero" },
          updatedAt: new Date(),
        })
        .where(eq(workerIdentityDesiredSlots.id, slot.id));
      continue;
    }

    if (slot.adapterType !== "managed_worker") {
      const err = `unsupported adapter_type for slot ${slot.profileKey}`;
      errors.push(err);
      await db
        .update(workerIdentityDesiredSlots)
        .set({
          lastReconciledAt: new Date(),
          lastReconcileError: err,
          updatedAt: new Date(),
        })
        .where(eq(workerIdentityDesiredSlots.id, slot.id));
      continue;
    }

    try {
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(and(eq(agents.workerIdentitySlotId, slot.id), ne(agents.status, "terminated")));
      const count = Number(countRows[0]?.count ?? 0);
      const need = Math.max(0, desired - count);
      const createdIds: string[] = [];
      for (let i = 0; i < need; i++) {
        const created = await opts.createAgentFromSlot({ companyId, slot });
        createdIds.push(created.id);
        agentsCreated += 1;
      }

      await db
        .update(workerIdentityDesiredSlots)
        .set({
          lastReconciledAt: new Date(),
          lastReconcileError: null,
          lastReconcileSummary: {
            createdAgentIds: createdIds,
            previousCount: count,
            target: desired,
          },
          updatedAt: new Date(),
        })
        .where(eq(workerIdentityDesiredSlots.id, slot.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${slot.profileKey}: ${msg}`);
      await db
        .update(workerIdentityDesiredSlots)
        .set({
          lastReconciledAt: new Date(),
          lastReconcileError: msg,
          updatedAt: new Date(),
        })
        .where(eq(workerIdentityDesiredSlots.id, slot.id));
    }
  }

  return { companyId, slotsProcessed, agentsCreated, errors };
}

/** Companies that have at least one enabled slot with desired_count > 0 (periodic reconcile). */
export async function listCompanyIdsWithActiveWorkerIdentitySlots(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ companyId: workerIdentityDesiredSlots.companyId })
    .from(workerIdentityDesiredSlots)
    .where(
      and(eq(workerIdentityDesiredSlots.enabled, true), gt(workerIdentityDesiredSlots.desiredCount, 0)),
    );
  return rows.map((r) => r.companyId);
}
