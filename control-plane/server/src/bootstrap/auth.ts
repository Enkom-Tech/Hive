import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@hive/db";
import type { Request, RequestHandler } from "express";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import type { PrincipalResolver } from "../middleware/auth.js";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { initializeBoardClaimChallenge } from "../board-claim.js";

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

async function ensureLocalTrustedBoardPrincipal(db: Db): Promise<void> {
  const now = new Date();
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@hive.local";
  const LOCAL_BOARD_USER_NAME = "Board";

  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  if (!existingUser) {
    await db.insert(authUsers).values({
      id: LOCAL_BOARD_USER_ID,
      name: LOCAL_BOARD_USER_NAME,
      email: LOCAL_BOARD_USER_EMAIL,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const role = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  if (!role) {
    await db.insert(instanceUserRoles).values({
      userId: LOCAL_BOARD_USER_ID,
      role: "instance_admin",
    });
  }

  const companyRows = await db.select({ id: companies.id }).from(companies);
  for (const company of companyRows) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
        ),
      )
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);

    if (membership) continue;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "admin",
    });
  }
}

export interface BootstrapAuthResult {
  authReady: boolean;
  betterAuthHandler: RequestHandler | undefined;
  resolveSession: ((req: Request) => Promise<BetterAuthSessionResult | null>) | undefined;
  resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  principalResolver: PrincipalResolver;
}

export async function bootstrapAuth(config: Config, db: Db): Promise<BootstrapAuthResult> {
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }

  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }

  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }

  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: Request) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;

  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db);
  }

  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("../auth/better-auth.js");

    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...config.trustedOriginsExtra]));

    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          extra: config.trustedOriginsExtra.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );

    const auth = createBetterAuthInstance(db, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db, { deploymentMode: config.deploymentMode });
    authReady = true;
  }

  if (config.authProvider === "logto") {
    throw new Error("AUTH_PROVIDER=logto is not implemented yet. Use AUTH_PROVIDER=builtin.");
  }

  const { resolvePrincipalBuiltin } = await import("../auth/resolvers/builtin.js");
  const principalResolver: PrincipalResolver = (req) =>
    resolvePrincipalBuiltin(req, {
      db,
      deploymentMode: config.deploymentMode,
      resolveSession: resolveSession ?? undefined,
    });

  return {
    authReady,
    betterAuthHandler,
    resolveSession,
    resolveSessionFromHeaders,
    principalResolver,
  };
}

