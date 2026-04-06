import type { IncomingMessage, IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@hive/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@hive/db";
import type { Config } from "../config.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = ReturnType<typeof betterAuth>;

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromNodeRequest(req: IncomingMessage): Headers {
  return headersFromNodeHeaders(req.headers);
}

function addLoopbackOriginAliases(origins: Set<string>): void {
  const extras: string[] = [];
  for (const origin of origins) {
    try {
      const u = new URL(origin);
      if (u.hostname === "localhost") {
        u.hostname = "127.0.0.1";
        extras.push(u.origin);
      } else if (u.hostname === "127.0.0.1") {
        u.hostname = "localhost";
        extras.push(u.origin);
      }
    } catch {
      // ignore non-URL entries
    }
  }
  for (const o of extras) origins.add(o);
}

export function deriveAuthTrustedOrigins(config: Config): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
    }
    // Hive config defaults `allowedHostnames` to []. With no explicit authPublicBaseUrl,
    // that yields an empty trustedOrigins list and Better Auth rejects browser requests,
    // so session cookies never stick and /api/auth/get-session + board APIs return 401/403.
    if (config.allowedHostnames.length === 0 && !config.authPublicBaseUrl?.trim()) {
      const port = config.port;
      trustedOrigins.add(`http://127.0.0.1:${port}`);
      trustedOrigins.add(`http://localhost:${port}`);
    }
  }

  addLoopbackOriginAliases(trustedOrigins);

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins?: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = config.authSecret ?? "hive-dev-secret";
  const effectiveTrustedOrigins = trustedOrigins ?? deriveAuthTrustedOrigins(config);

  const publicUrl = config.authPublicBaseUrl ?? baseUrl;
  const isHttpOnly = publicUrl ? publicUrl.startsWith("http://") : false;

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins: effectiveTrustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    ...(isHttpOnly ? { advanced: { useSecureCookies: false } } : {}),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig) as BetterAuthInstance;
}

export function createBetterAuthHandler(
  auth: BetterAuthInstance,
): (req: IncomingMessage, res: import("node:http").ServerResponse, next: (err?: unknown) => void) => void {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: IncomingMessage,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromNodeRequest(req));
}
