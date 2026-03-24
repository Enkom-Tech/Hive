import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, workerInstances } from "@hive/db";
import { isUuidLike } from "@hive/shared";
import { logger } from "../middleware/logger.js";

export type WorkerHelloPayload = {
  hostname: string | null;
  os: string | null;
  arch: string | null;
  version: string | null;
  instanceId: string | null;
};

function trimString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Returns null if this is not a well-formed hello message. */
export function parseWorkerHelloMessage(msg: Record<string, unknown>): WorkerHelloPayload | null {
  if (typeof msg.type !== "string" || msg.type !== "hello") return null;
  return {
    hostname: trimString(msg.hostname),
    os: trimString(msg.os),
    arch: trimString(msg.arch),
    version: trimString(msg.version),
    instanceId: trimString(msg.instanceId),
  };
}

export function parseDroneFromAgentMetadata(metadata: unknown): {
  hostname: string | null;
  os: string | null;
  arch: string | null;
  version: string | null;
  instanceId: string | null;
  lastHelloAt: string | null;
} | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const drone = (metadata as Record<string, unknown>).drone;
  if (!drone || typeof drone !== "object" || Array.isArray(drone)) return null;
  const d = drone as Record<string, unknown>;
  return {
    hostname: trimString(d.hostname),
    os: trimString(d.os),
    arch: trimString(d.arch),
    version: trimString(d.version),
    instanceId: trimString(d.instanceId),
    lastHelloAt: trimString(d.lastHelloAt),
  };
}

/**
 * Upsert `worker_instances` from hello payload (stable instance UUID). No agent row updates.
 * Used for drone-first provision links before any board identity is bound.
 */
export async function upsertWorkerInstanceFromHello(
  db: Db,
  companyId: string,
  payload: WorkerHelloPayload,
): Promise<{ instanceRowId: string | null; created: boolean }> {
  const now = new Date();
  const lastHelloAt = now.toISOString();
  let instanceRowId: string | null = null;
  let created = false;

  const sid = payload.instanceId;
  if (!sid || !isUuidLike(sid)) return { instanceRowId: null, created: false };

  await db.transaction(async (tx) => {
    const existingInst = await tx
      .select()
      .from(workerInstances)
      .where(and(eq(workerInstances.companyId, companyId), eq(workerInstances.stableInstanceId, sid)))
      .then((rows) => rows[0] ?? null);

    const mergedIm: Record<string, unknown> = {
      ...(existingInst &&
      typeof existingInst.metadata === "object" &&
      existingInst.metadata !== null &&
      !Array.isArray(existingInst.metadata)
        ? (existingInst.metadata as Record<string, unknown>)
        : {}),
      lastHostname: payload.hostname,
      lastVersion: payload.version,
      lastOs: payload.os,
      lastArch: payload.arch,
      lastHelloAt,
    };

    if (existingInst) {
      instanceRowId = existingInst.id;
      await tx
        .update(workerInstances)
        .set({ lastSeenAt: now, metadata: mergedIm, updatedAt: now })
        .where(eq(workerInstances.id, existingInst.id));
    } else {
      const [inserted] = await tx
        .insert(workerInstances)
        .values({
          companyId,
          stableInstanceId: sid,
          lastSeenAt: now,
          metadata: mergedIm,
          updatedAt: now,
        })
        .returning({ id: workerInstances.id });
      if (!inserted) {
        return;
      }
      instanceRowId = inserted.id;
      created = true;
    }
  });

  return { instanceRowId, created };
}

/**
 * Bumps `worker_instances.last_seen_at` when a drone opens an instance-scoped link without sending a new `hello`
 * (reconnect after token refresh / control plane restart). Keeps board telemetry aligned with an open socket.
 */
export async function touchWorkerInstanceLastSeenAt(
  db: Db,
  companyId: string,
  workerInstanceRowId: string,
): Promise<void> {
  const now = new Date();
  const row = await db
    .update(workerInstances)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(and(eq(workerInstances.id, workerInstanceRowId), eq(workerInstances.companyId, companyId)))
    .returning({ id: workerInstances.id })
    .then((rows) => rows[0] ?? null);
  if (!row) {
    logger.warn({ companyId, workerInstanceRowId }, "touchWorkerInstanceLastSeenAt: no row matched");
  }
}

/**
 * Persists drone hello on the agent row and upserts `worker_instances` when `instanceId` is a UUID.
 * Does **not** write `worker_instance_agents` (ADR 005 — assignment is explicit via worker-assignment).
 * Returns internal `worker_instances.id` when the instance row was found or created.
 */
export async function applyWorkerHello(
  db: Db,
  agentId: string,
  companyId: string,
  payload: WorkerHelloPayload,
): Promise<{ instanceRowId: string | null }> {
  const now = new Date();
  const lastHelloAt = now.toISOString();
  let instanceRowId: string | null = null;

  await db.transaction(async (tx) => {
    const row = await tx.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId) return;

    const prevMeta =
      typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...(row.metadata as Record<string, unknown>) }
        : {};
    prevMeta.drone = {
      hostname: payload.hostname,
      os: payload.os,
      arch: payload.arch,
      version: payload.version,
      instanceId: payload.instanceId,
      lastHelloAt,
    };

    await tx.update(agents).set({ metadata: prevMeta, updatedAt: now }).where(eq(agents.id, agentId));

    const sid = payload.instanceId;
    if (!sid || !isUuidLike(sid)) return;

    const existingInst = await tx
      .select()
      .from(workerInstances)
      .where(and(eq(workerInstances.companyId, companyId), eq(workerInstances.stableInstanceId, sid)))
      .then((rows) => rows[0] ?? null);

    const mergedIm: Record<string, unknown> = {
      ...(existingInst &&
      typeof existingInst.metadata === "object" &&
      existingInst.metadata !== null &&
      !Array.isArray(existingInst.metadata)
        ? (existingInst.metadata as Record<string, unknown>)
        : {}),
      lastHostname: payload.hostname,
      lastVersion: payload.version,
      lastOs: payload.os,
      lastArch: payload.arch,
      lastHelloAt,
    };

    if (existingInst) {
      instanceRowId = existingInst.id;
      await tx
        .update(workerInstances)
        .set({ lastSeenAt: now, metadata: mergedIm, updatedAt: now })
        .where(eq(workerInstances.id, existingInst.id));
    } else {
      const [inserted] = await tx
        .insert(workerInstances)
        .values({
          companyId,
          stableInstanceId: sid,
          lastSeenAt: now,
          metadata: mergedIm,
          updatedAt: now,
        })
        .returning({ id: workerInstances.id });
      if (!inserted) {
        return;
      }
      instanceRowId = inserted.id;
    }

  });

  return { instanceRowId };
}

export type ScheduleWorkerHelloHooks = {
  /** Invoked after hello is persisted (same process only; use for link registry hints). */
  afterPersist?: (payload: WorkerHelloPayload, result: { instanceRowId: string | null }) => void;
};

export function scheduleWorkerHello(
  db: Db,
  agentId: string,
  companyId: string,
  msg: Record<string, unknown>,
  hooks?: ScheduleWorkerHelloHooks,
): void {
  const payload = parseWorkerHelloMessage(msg);
  if (!payload) return;
  void applyWorkerHello(db, agentId, companyId, payload)
    .then((result) => {
      hooks?.afterPersist?.(payload, result);
    })
    .catch((err) => {
      logger.error({ err, agentId }, "worker hello persist failed");
    });
}
