import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { droneProvisioningTokens, workerInstanceLinkEnrollmentTokens, workerInstances } from "@hive/db";
import { notFound } from "../../errors.js";
import {
  createDroneProvisioningTokenPlain,
  createLinkEnrollmentTokenPlain,
  hashToken,
} from "./tokens.js";

export async function createWorkerInstanceLinkEnrollmentTokenOp(
  db: Db,
  companyId: string,
  workerInstanceId: string,
  ttlSeconds: number,
  options?: { maxTtlSeconds?: number },
) {
  const inst = await db
    .select({ id: workerInstances.id })
    .from(workerInstances)
    .where(and(eq(workerInstances.id, workerInstanceId), eq(workerInstances.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!inst) throw notFound("Worker instance not found");

  const cap = options?.maxTtlSeconds ?? 3600;
  const ttl = Math.min(cap, Math.max(120, Math.floor(ttlSeconds) || 900));
  const token = createLinkEnrollmentTokenPlain();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db.insert(workerInstanceLinkEnrollmentTokens).values({
    workerInstanceId,
    companyId,
    tokenHash,
    expiresAt,
  });

  return { token, expiresAt };
}

export async function createDroneProvisioningTokenOp(db: Db, companyId: string, ttlSeconds: number) {
  const ttl = Math.min(3600, Math.max(120, Math.floor(ttlSeconds) || 900));
  const token = createDroneProvisioningTokenPlain();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db.insert(droneProvisioningTokens).values({
    companyId,
    tokenHash,
    expiresAt,
  });

  return { token, expiresAt };
}
