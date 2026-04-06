import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@hive/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { authUsers, instanceUserRoles, invites } from "@hive/db";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import type { InstanceStatusHealthSnapshot } from "@hive/shared";

export type HealthRouteOptions = {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  /** When true, self-service sign-up is off regardless of user count. */
  authDisableSignUp?: boolean;
};

export async function collectHealthPayload(db: Db, opts: HealthRouteOptions): Promise<InstanceStatusHealthSnapshot> {
  let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
  let bootstrapInviteActive = false;
  if (opts.deploymentMode === "authenticated") {
    const roleCount = await db
      .select({ count: count() })
      .from(instanceUserRoles)
      .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
      .then((rows) => Number(rows[0]?.count ?? 0));
    bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

    if (bootstrapStatus === "bootstrap_pending") {
      const now = new Date();
      const inviteCount = await db
        .select({ count: count() })
        .from(invites)
        .where(
          and(
            eq(invites.inviteType, "bootstrap_ceo"),
            isNull(invites.revokedAt),
            isNull(invites.acceptedAt),
            gt(invites.expiresAt, now),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapInviteActive = inviteCount > 0;
    }
  }

  let signUpDisabled = false;
  if (opts.deploymentMode === "authenticated") {
    const userCount = await db
      .select({ c: count() })
      .from(authUsers)
      .then((rows) => Number(rows[0]?.c ?? 0));
    signUpDisabled = Boolean(opts.authDisableSignUp) || userCount > 0;
  }

  return {
    status: "ok",
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    authReady: opts.authReady,
    bootstrapStatus,
    bootstrapInviteActive,
    auth: {
      signUpDisabled,
    },
    features: {
      companyDeletionEnabled: opts.companyDeletionEnabled,
    },
  };
}

/**
 * Fastify-native health plugin.
 * Registers GET /api/health (board UI, CLI, docs) and GET /health (simple probe alias).
 */
export async function healthPlugin(
  fastify: FastifyInstance,
  opts: FastifyPluginOptions & { db?: Db } & HealthRouteOptions,
): Promise<void> {
  const handler = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!opts.db) {
      return reply.send({ status: "ok" });
    }
    const payload = await collectHealthPayload(opts.db, opts);
    return reply.send(payload);
  };
  fastify.get("/api/health", handler);
  fastify.get("/health", handler);
}
