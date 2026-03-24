import { Router } from "express";
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

export function healthRoutes(
  db?: Db,
  opts: HealthRouteOptions = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
    authDisableSignUp: false,
  },
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok" });
      return;
    }

    const payload = await collectHealthPayload(db, opts);
    res.json(payload);
  });

  return router;
}
