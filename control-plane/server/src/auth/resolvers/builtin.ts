import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@hive/db";
import { LOCAL_BOARD_USER_ID } from "../../board-claim.js";
import type { Principal } from "@hive/shared";
import type { DeploymentMode } from "@hive/shared";
import { verifyLocalAgentJwt } from "../../agent-auth-jwt.js";
import { verifyBoardJwt } from "../board-jwt.js";
import { verifyWorkerJwt } from "../worker-jwt.js";
import type { BetterAuthSessionResult } from "../better-auth.js";
import { logger } from "../../middleware/logger.js";
import { accessService } from "../../services/access.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface BuiltinResolverDeps {
  db: Db;
  deploymentMode: DeploymentMode;
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
}

export async function resolvePrincipalBuiltin(
  req: FastifyRequest,
  deps: BuiltinResolverDeps,
): Promise<Principal | null> {
  const runIdHeader = req.headers["x-hive-run-id"] as string | undefined;

  if (deps.deploymentMode === "local_trusted") {
    const memberships = await deps.db
      .select({ companyId: companyMemberships.companyId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          eq(companyMemberships.status, "active"),
        ),
      );
    return {
      type: "user",
      id: LOCAL_BOARD_USER_ID,
      company_ids: memberships.map((m) => m.companyId),
      roles: ["instance_admin"],
    };
  }

  const authHeaderRaw = req.headers["authorization"];
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
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

    const workerClaims = verifyWorkerJwt(token);
    if (workerClaims) {
      return {
        type: "worker_instance",
        id: workerClaims.sub,
        company_id: workerClaims.company_id,
        workerInstanceRowId: workerClaims.sub,
        roles: [],
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

  if (deps.deploymentMode === "authenticated") {
    let session: BetterAuthSessionResult | null = null;
    try {
      if (deps.resolveSessionFromHeaders) {
        const headers = new Headers();
        for (const [key, val] of Object.entries(req.headers)) {
          if (!val) continue;
          if (Array.isArray(val)) {
            for (const v of val) headers.append(key, v);
          } else {
            headers.set(key, val);
          }
        }
        session = await deps.resolveSessionFromHeaders(headers);
      }
    } catch (err) {
      logger.warn(
        { err, method: req.method, url: req.url },
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
              { err, userId, method: req.method, url: req.url },
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
