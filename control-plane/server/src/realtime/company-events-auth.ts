import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@hive/db";
import type { DeploymentMode } from "@hive/shared";

export interface CompanyEventsContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
}

export interface AuthorizeCompanyEventsAccessOpts {
  deploymentMode: DeploymentMode;
  /** Bearer token or query token (agent API key). */
  token: string | null;
  /** User id from session (for board access in authenticated mode). */
  sessionUserId: string | null;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Authorizes access to company-scoped live events (SSE or WebSocket).
 * Returns context if the actor may subscribe to events for the given company; null otherwise.
 */
export async function authorizeCompanyEventsAccess(
  db: Db,
  companyId: string,
  opts: AuthorizeCompanyEventsAccessOpts,
): Promise<CompanyEventsContext | null> {
  const { deploymentMode, token, sessionUserId } = opts;

  if (token) {
    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key || key.companyId !== companyId) {
      return null;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    return {
      companyId,
      actorType: "agent",
      actorId: key.agentId,
    };
  }

  if (deploymentMode === "local_trusted") {
    return {
      companyId,
      actorType: "board",
      actorId: "board",
    };
  }

  if (deploymentMode !== "authenticated" || !sessionUserId) {
    return null;
  }

  const userId = sessionUserId;
  const [roleRow, memberships] = await Promise.all([
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db
      .select({ companyId: companyMemberships.companyId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
  ]);

  const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
  if (!roleRow && !hasCompanyMembership) return null;

  return {
    companyId,
    actorType: "board",
    actorId: userId,
  };
}
