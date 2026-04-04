import { eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { authUsers, invites, joinRequests } from "@hive/db";
import { PERMISSION_KEYS } from "@hive/shared";
import { redactEventPayload } from "../../../redaction.js";
import type { PrincipalCarrier, HeaderCarrier } from "../../authz.js";

export function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  const { claimSecretHash: _claimSecretHash, ...safe } = row;
  if (safe.agentDefaultsPayload && typeof safe.agentDefaultsPayload === "object") {
    safe.agentDefaultsPayload = redactEventPayload(
      safe.agentDefaultsPayload as Record<string, unknown>,
    ) as typeof safe.agentDefaultsPayload;
  }
  return safe;
}

export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent",
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null,
    });
  }
  return result;
}

export type JoinRequestManagerCandidate = {
  id: string;
  role: string;
  reportsTo: string | null;
};

export function resolveJoinRequestAgentManagerId(
  candidates: JoinRequestManagerCandidate[],
): string | null {
  const ceoCandidates = candidates.filter(
    (candidate) => candidate.role === "ceo",
  );
  if (ceoCandidates.length === 0) return null;
  const rootCeo = ceoCandidates.find(
    (candidate) => candidate.reportsTo === null,
  );
  return (rootCeo ?? ceoCandidates[0] ?? null)?.id ?? null;
}

export function requestIpF(req: HeaderCarrier): string {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const forwarded = headers["x-forwarded-for"];
  const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedStr) {
    const first = forwardedStr.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

export async function resolveActorEmailF(
  db: Db,
  req: PrincipalCarrier,
): Promise<string | null> {
  const p = req.principal ?? null;
  if (p?.type === "system") return "local@hive.local";
  if (p?.type === "user" && p.id === "local-board") return "local@hive.local";
  const userId = p?.type === "user" ? p.id : null;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

export function isLocalImplicitF(req: PrincipalCarrier): boolean {
  const p = req.principal ?? null;
  if (p?.type === "system") return true;
  return p?.type === "user" && p.id === "local-board";
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

type InviteResolutionProbe = {
  status: "reachable" | "timeout" | "unreachable";
  method: "HEAD";
  durationMs: number;
  httpStatus: number | null;
  message: string;
};

export async function probeInviteResolutionTarget(
  url: URL,
  timeoutMs: number,
): Promise<InviteResolutionProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    if (
      response.ok ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 405 ||
      response.status === 422 ||
      response.status === 500 ||
      response.status === 501
    ) {
      return {
        status: "reachable",
        method: "HEAD",
        durationMs,
        httpStatus: response.status,
        message: `Webhook endpoint responded to HEAD with HTTP ${response.status}.`,
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: response.status,
      message: `Webhook endpoint probe returned HTTP ${response.status}.`,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isAbortError(error)) {
      return {
        status: "timeout",
        method: "HEAD",
        durationMs,
        httpStatus: null,
        message: `Webhook endpoint probe timed out after ${timeoutMs}ms.`,
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: null,
      message:
        error instanceof Error
          ? error.message
          : "Webhook endpoint probe failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
