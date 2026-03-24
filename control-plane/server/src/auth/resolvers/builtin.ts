import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@hive/db";
import type { Principal } from "@hive/shared";
import type { DeploymentMode } from "@hive/shared";
import { verifyLocalAgentJwt } from "../../agent-auth-jwt.js";
import { verifyBoardJwt } from "../board-jwt.js";
import type { BetterAuthSessionResult } from "../better-auth.js";
import { logger } from "../../middleware/logger.js";
import { LOCAL_BOARD_USER_ID } from "../../board-claim.js";
import { accessService } from "../../services/access.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface BuiltinResolverDeps {
  db: Db;
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export async function resolvePrincipalBuiltin(
  req: Request,
  deps: BuiltinResolverDeps,
): Promise<Principal | null> {
  const runIdHeader = req.header("x-hive-run-id") ?? undefined;

  if (deps.deploymentMode === "local_trusted") {
    return {
      type: "system",
      id: "local-board",
      roles: ["instance_admin"],
    };
  }

  const authHeader = req.header("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (!token) return null;

    const tokenHash = hashToken(token);
    const key = await deps.db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (key) {
      await deps.db
        .update(agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentApiKeys.id, key.id));

      const agentRecord = await deps.db
        .select()
        .from(agents)
        .where(eq(agents.id, key.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        return null;
      }

      return {
        type: "agent",
        id: key.agentId,
        company_id: key.companyId,
        roles: [],
        runId: runIdHeader,
        keyId: key.id,
      };
    }

    const agentClaims = verifyLocalAgentJwt(token);
    if (agentClaims) {
      const agentRecord = await deps.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentClaims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== agentClaims.company_id) return null;
      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") return null;

      return {
        type: "agent",
        id: agentClaims.sub,
        company_id: agentClaims.company_id,
        roles: [],
        runId: runIdHeader || agentClaims.run_id,
      };
    }

    const boardClaims = verifyBoardJwt(token);
    if (boardClaims) {
      return {
        type: "user",
        id: boardClaims.sub,
        company_ids: boardClaims.company_ids,
        roles: boardClaims.instance_admin ? ["instance_admin"] : [],
      };
    }

    return null;
  }

  if (deps.deploymentMode === "authenticated" && deps.resolveSession) {
    let session: BetterAuthSessionResult | null = null;
    try {
      session = await deps.resolveSession(req);
    } catch (err) {
      logger.warn(
        { err, method: req.method, url: req.originalUrl },
        "Failed to resolve auth session from request headers",
      );
    }
    if (session?.user?.id) {
      const userId = session.user.id;
      let roleRow = await deps.db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null);

      if (!roleRow) {
        const anyInstanceAdmin = await deps.db
          .select({ id: instanceUserRoles.id })
          .from(instanceUserRoles)
          .where(
            and(
              eq(instanceUserRoles.role, "instance_admin"),
              ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!anyInstanceAdmin) {
          try {
            await accessService(deps.db).promoteFirstInstanceAdminIfVacant(userId);
          } catch (err) {
            logger.warn(
              { err, userId, method: req.method, url: req.originalUrl },
              "Failed to bootstrap first instance admin from session",
            );
          }
          roleRow = await deps.db
            .select({ id: instanceUserRoles.id })
            .from(instanceUserRoles)
            .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
            .then((rows) => rows[0] ?? null);
        }
      }

      const memberships = await deps.db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      return {
        type: "user",
        id: userId,
        company_ids: memberships.map((row) => row.companyId),
        roles: roleRow ? ["instance_admin"] : [],
      };
    }
  }

  return null;
}
