import type { Db } from "@hive/db";
import type { PermissionKey, Principal } from "@hive/shared";
import { forbidden, unauthorized } from "../errors.js";
import { accessService } from "../services/access.js";
import { LOCAL_BOARD_USER_ID } from "../board-claim.js";

/**
 * Minimal interface satisfied by both Express.Request and FastifyRequest.
 * Only `principal` is required here; header access is handled per-helper.
 */
export interface PrincipalCarrier {
  principal?: Principal | null;
}

export function getCurrentPrincipalFromCarrier(req: PrincipalCarrier): Principal | null {
  return req.principal ?? null;
}

function isLocalImplicitFromCarrier(req: PrincipalCarrier): boolean {
  const p = getCurrentPrincipalFromCarrier(req);
  if (p?.type === "system") return true;
  return p?.type === "user" && p.id === LOCAL_BOARD_USER_ID;
}

/** When true, local_trusted `local-board` user must pass normal grant checks (integration / CI RBAC tests). */
function rbacEnforceForLocalImplicitBoard(): boolean {
  const v = process.env.HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function assertBoard(req: PrincipalCarrier) {
  const p = getCurrentPrincipalFromCarrier(req);
  const isBoard = p?.type === "user" || p?.type === "system";
  if (!isBoard) {
    throw forbidden("Board access required");
  }
}

export function assertInstanceAdmin(req: PrincipalCarrier) {
  assertBoard(req);
  const p = getCurrentPrincipalFromCarrier(req);
  if (p?.type === "system") {
    return;
  }
  if (p?.type === "user" && p.roles.includes("instance_admin")) {
    return;
  }
  throw forbidden("Instance admin required");
}

/**
 * Company scope + permission check for board HTTP APIs.
 * Local implicit board and system principal bypass grant evaluation.
 */
export async function assertCompanyPermission(
  db: Db,
  req: PrincipalCarrier,
  companyId: string,
  permissionKey: PermissionKey,
): Promise<void> {
  assertCompanyAccess(req, companyId);
  const p = getCurrentPrincipalFromCarrier(req);
  if (p?.type === "worker_instance") {
    throw forbidden("Worker instance cannot use board permission checks");
  }
  if (p?.type === "system") {
    return;
  }
  if (isLocalImplicitFromCarrier(req) && !rbacEnforceForLocalImplicitBoard()) {
    return;
  }
  const access = accessService(db);
  if (p?.type === "agent") {
    if (!p.id) throw forbidden();
    const allowed = await access.hasPermission(companyId, "agent", p.id, permissionKey);
    if (!allowed) throw forbidden("Permission denied");
    return;
  }
  if (p?.type === "user") {
    if (p.roles.includes("instance_admin")) return;
    const allowed = await access.canUser(companyId, p.id, permissionKey);
    if (!allowed) throw forbidden("Permission denied");
    return;
  }
  throw forbidden("Permission denied");
}

export async function assertCompanyRead(db: Db, req: PrincipalCarrier, companyId: string): Promise<void> {
  await assertCompanyPermission(db, req, companyId, "company:read");
}

export function assertCompanyAccess(req: PrincipalCarrier, companyId: string) {
  const p = getCurrentPrincipalFromCarrier(req);
  if (!p) {
    throw unauthorized();
  }
  if (p.type === "agent") {
    if (p.company_id !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return;
  }
  if (p.type === "worker_instance") {
    if (p.company_id !== companyId) {
      throw forbidden("Worker instance cannot access another company");
    }
    return;
  }
  if (p.type === "user" || p.type === "system") {
    if (p.type === "system") return;
    if (p.roles.includes("instance_admin")) return;
    const allowed = p.company_ids ?? [];
    if (!allowed.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }
}

export function assertWorkerInstance(req: PrincipalCarrier): { workerInstanceRowId: string; companyId: string } {
  const p = getCurrentPrincipalFromCarrier(req);
  if (!p || p.type !== "worker_instance" || !p.company_id || !p.workerInstanceRowId) {
    throw forbidden("Worker instance authentication required");
  }
  return { workerInstanceRowId: p.workerInstanceRowId, companyId: p.company_id };
}

export function getActorInfo(req: PrincipalCarrier) {
  const p = getCurrentPrincipalFromCarrier(req);
  if (!p) {
    throw unauthorized();
  }
  if (p.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: p.id,
      agentId: p.id,
      runId: p.runId ?? null,
    };
  }
  if (p.type === "worker_instance") {
    throw forbidden("Worker instance cannot use board actor info");
  }
  return {
    actorType: "user" as const,
    actorId: p.id,
    agentId: null,
    runId: undefined,
  };
}

/**
 * Minimal interface for header access, satisfied by both Express.Request and FastifyRequest.
 * Fastify uses `req.headers` (lowercase dict); Express also exposes `req.header(name)`.
 * We use `req.headers` only so both frameworks satisfy this interface.
 */
export interface HeaderCarrier {
  headers: Record<string, string | string[] | undefined>;
}

function getHeader(req: HeaderCarrier, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

/** Actor for worker-api calls: attributes actions to the agent named in the request body. */
export function getWorkerApiActorInfo(req: HeaderCarrier, agentId: string) {
  const runId = getHeader(req, "x-hive-run-id")?.trim() || null;
  return {
    actorType: "agent" as const,
    actorId: agentId,
    agentId,
    runId,
  };
}
