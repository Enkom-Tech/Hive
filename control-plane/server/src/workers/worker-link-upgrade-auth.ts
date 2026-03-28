import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agentApiKeys,
  agents,
  droneProvisioningTokens,
  managedWorkerLinkEnrollmentTokens,
  workerInstanceAgents,
  workerInstanceLinkEnrollmentTokens,
} from "@hive/db";
import type { LinkAuth } from "./worker-link-types.js";

export type WorkerLinkUpgradeAuthResult =
  | { ok: true; auth: LinkAuth }
  | { ok: false; statusLine: string; message: string };

export async function resolveWorkerLinkUpgradeAuth(
  db: Db,
  tokenHash: string,
): Promise<WorkerLinkUpgradeAuthResult> {
  const provisionCandidate = await db
    .select({
      id: droneProvisioningTokens.id,
      companyId: droneProvisioningTokens.companyId,
    })
    .from(droneProvisioningTokens)
    .where(
      and(
        eq(droneProvisioningTokens.tokenHash, tokenHash),
        isNull(droneProvisioningTokens.consumedAt),
        gt(droneProvisioningTokens.expiresAt, new Date()),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (provisionCandidate) {
    return {
      ok: true,
      auth: {
        kind: "provision",
        companyId: provisionCandidate.companyId,
        provisioningTokenRowId: provisionCandidate.id,
      },
    };
  }

  const instanceEnrollment = await db
    .select({
      id: workerInstanceLinkEnrollmentTokens.id,
      workerInstanceId: workerInstanceLinkEnrollmentTokens.workerInstanceId,
      companyId: workerInstanceLinkEnrollmentTokens.companyId,
    })
    .from(workerInstanceLinkEnrollmentTokens)
    .where(
      and(
        eq(workerInstanceLinkEnrollmentTokens.tokenHash, tokenHash),
        isNull(workerInstanceLinkEnrollmentTokens.consumedAt),
        gt(workerInstanceLinkEnrollmentTokens.expiresAt, new Date()),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (instanceEnrollment) {
    const boundRows = await db
      .select({ agentId: workerInstanceAgents.agentId })
      .from(workerInstanceAgents)
      .where(eq(workerInstanceAgents.workerInstanceId, instanceEnrollment.workerInstanceId));

    const consumed = await db
      .update(workerInstanceLinkEnrollmentTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(workerInstanceLinkEnrollmentTokens.id, instanceEnrollment.id),
          isNull(workerInstanceLinkEnrollmentTokens.consumedAt),
          gt(workerInstanceLinkEnrollmentTokens.expiresAt, new Date()),
        ),
      )
      .returning({ id: workerInstanceLinkEnrollmentTokens.id })
      .then((rows) => rows[0] ?? null);
    if (!consumed) {
      return { ok: false, statusLine: "401 Unauthorized", message: "invalid token" };
    }

    return {
      ok: true,
      auth: {
        kind: "instance",
        workerInstanceRowId: instanceEnrollment.workerInstanceId,
        companyId: instanceEnrollment.companyId,
        boundAgentIds: boundRows.map((r) => r.agentId),
      },
    };
  }

  const enrollmentCandidate = await db
    .select({
      id: managedWorkerLinkEnrollmentTokens.id,
      agentId: managedWorkerLinkEnrollmentTokens.agentId,
      companyId: managedWorkerLinkEnrollmentTokens.companyId,
    })
    .from(managedWorkerLinkEnrollmentTokens)
    .where(
      and(
        eq(managedWorkerLinkEnrollmentTokens.tokenHash, tokenHash),
        isNull(managedWorkerLinkEnrollmentTokens.consumedAt),
        gt(managedWorkerLinkEnrollmentTokens.expiresAt, new Date()),
      ),
    )
    .then((rows) => rows[0] ?? null);

  let agentId: string;
  let companyId: string;
  let enrollmentRowId: string | null = null;

  if (enrollmentCandidate) {
    agentId = enrollmentCandidate.agentId;
    companyId = enrollmentCandidate.companyId;
    enrollmentRowId = enrollmentCandidate.id;
  } else {
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      return { ok: false, statusLine: "401 Unauthorized", message: "invalid token" };
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    agentId = key.agentId;
    companyId = key.companyId;
  }

  const agentRecord = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
    return { ok: false, statusLine: "403 Forbidden", message: "agent not allowed" };
  }

  if (enrollmentRowId) {
    const consumed = await db
      .update(managedWorkerLinkEnrollmentTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(managedWorkerLinkEnrollmentTokens.id, enrollmentRowId),
          isNull(managedWorkerLinkEnrollmentTokens.consumedAt),
          gt(managedWorkerLinkEnrollmentTokens.expiresAt, new Date()),
        ),
      )
      .returning({ id: managedWorkerLinkEnrollmentTokens.id })
      .then((rows) => rows[0] ?? null);
    if (!consumed) {
      return { ok: false, statusLine: "401 Unauthorized", message: "invalid token" };
    }
  }

  return { ok: true, auth: { kind: "agent", agentId, companyId } };
}
