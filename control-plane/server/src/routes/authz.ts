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
  if (p.type === "user" || p.type === "system") {
    if (p.type === "system") return;
    if (p.roles.includes("instance_admin")) return;
    const allowed = p.company_ids ?? [];
    if (!allowed.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }
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
  return {
    actorType: "user" as const,
    actorId: p.id,
    agentId: null,
    runId: undefined,
  };
}
