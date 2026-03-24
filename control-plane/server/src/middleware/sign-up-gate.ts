import type { RequestHandler } from "express";
import { count } from "drizzle-orm";
import type { Db } from "@hive/db";
import { authUsers } from "@hive/db";
import type { DeploymentMode } from "@hive/shared";

/**
 * Blocks Better Auth email sign-up when disabled by config or when at least one user exists
 * (authenticated deployments only).
 */
export function createAuthenticatedSignUpGateMiddleware(
  db: Db,
  opts: { deploymentMode: DeploymentMode; authDisableSignUp: boolean },
): RequestHandler {
  return async (req, res, next) => {
    if (opts.deploymentMode !== "authenticated") {
      next();
      return;
    }
    if ((req.method ?? "").toUpperCase() !== "POST") {
      next();
      return;
    }
    const url = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
    if (!url.includes("/sign-up/email")) {
      next();
      return;
    }
    const userCount = await db
      .select({ c: count() })
      .from(authUsers)
      .then((rows) => Number(rows[0]?.c ?? 0));
    const signUpDisabled = opts.authDisableSignUp || userCount > 0;
    if (signUpDisabled) {
      res.status(403).json({ message: "Sign up is disabled" });
      return;
    }
    next();
  };
}
