import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";
import { getCurrentPrincipal } from "../auth/principal.js";

export function assertBoard(req: Request) {
  const p = getCurrentPrincipal(req);
  const isBoard = p?.type === "user" || p?.type === "system";
  if (!isBoard) {
    throw forbidden("Board access required");
  }
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  const p = getCurrentPrincipal(req);
  if (p?.type === "system") {
    return;
  }
  if (p?.type === "user" && p.roles.includes("instance_admin")) {
    return;
  }
  throw forbidden("Instance admin required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  const p = getCurrentPrincipal(req);
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

export function assertWorkerInstance(req: Request): { workerInstanceRowId: string; companyId: string } {
  const p = getCurrentPrincipal(req);
  if (!p || p.type !== "worker_instance" || !p.company_id || !p.workerInstanceRowId) {
    throw forbidden("Worker instance authentication required");
  }
  return { workerInstanceRowId: p.workerInstanceRowId, companyId: p.company_id };
}

export function getActorInfo(req: Request) {
  const p = getCurrentPrincipal(req);
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

/** Actor for worker-api calls: attributes actions to the agent named in the request body. */
export function getWorkerApiActorInfo(req: Request, agentId: string) {
  const runId = req.header("x-hive-run-id")?.trim() || null;
  return {
    actorType: "agent" as const,
    actorId: agentId,
    agentId,
    runId,
  };
}
