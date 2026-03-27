import type { Request } from "express";
import type { Db } from "@hive/db";
import { optionalCompanyIdQuerySchema, isUuidLike } from "@hive/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { assertCompanyRead } from "../authz.js";
import type { accessService, agentService } from "../../services/index.js";

export type AgentRoutesCommonDeps = {
  db: Db;
  access: ReturnType<typeof accessService>;
  agentService: ReturnType<typeof agentService>;
};

export function canCreateAgents(agent: {
  role: string;
  permissions: Record<string, unknown> | null | undefined;
}): boolean {
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

export async function assertCanCreateAgentsForCompany(
  req: Request,
  companyId: string,
  deps: AgentRoutesCommonDeps,
): Promise<{ id: string; companyId: string } | null> {
  await assertCompanyRead(deps.db, req, companyId);
  const p = getCurrentPrincipal(req);
  const isBoard = p?.type === "user" || p?.type === "system";
  if (isBoard) {
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return null;
    const allowed = await deps.access.canUser(companyId, p?.id ?? "", "agents:create");
    if (!allowed) {
      throw forbidden("Missing permission: agents:create");
    }
    return null;
  }
  if (p?.type !== "agent" || !p.id) throw forbidden("Agent authentication required");
  const actorAgent = await deps.agentService.getById(p.id);
  if (!actorAgent || actorAgent.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  const allowedByGrant = await deps.access.hasPermission(
    companyId,
    "agent",
    actorAgent.id,
    "agents:create",
  );
  if (!allowedByGrant && !canCreateAgents(actorAgent)) {
    throw forbidden("Missing permission: can create agents");
  }
  return actorAgent;
}

export async function assertCanReadConfigurations(
  req: Request,
  companyId: string,
  deps: AgentRoutesCommonDeps,
): Promise<{ id: string; companyId: string } | null> {
  return assertCanCreateAgentsForCompany(req, companyId, deps);
}

export async function actorCanReadConfigurationsForCompany(
  req: Request,
  companyId: string,
  deps: AgentRoutesCommonDeps,
): Promise<boolean> {
  await assertCompanyRead(deps.db, req, companyId);
  const p = getCurrentPrincipal(req);
  const isBoard = p?.type === "user" || p?.type === "system";
  if (isBoard) {
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return true;
    return deps.access.canUser(companyId, p?.id ?? "", "agents:create");
  }
  if (p?.type !== "agent" || !p.id) return false;
  const actorAgent = await deps.agentService.getById(p.id);
  if (!actorAgent || actorAgent.companyId !== companyId) return false;
  const allowedByGrant = await deps.access.hasPermission(
    companyId,
    "agent",
    actorAgent.id,
    "agents:create",
  );
  return allowedByGrant || canCreateAgents(actorAgent);
}

export async function assertCanUpdateAgent(
  req: Request,
  targetAgent: { id: string; companyId: string },
  deps: AgentRoutesCommonDeps,
): Promise<void> {
  await assertCompanyRead(deps.db, req, targetAgent.companyId);
  const p = getCurrentPrincipal(req);
  const isBoard = p?.type === "user" || p?.type === "system";
  if (isBoard) {
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return;
    const allowed = await deps.access.canUser(targetAgent.companyId, p?.id ?? "", "agents:create");
    if (!allowed) throw forbidden("Missing permission: agents:create");
    return;
  }
  if (p?.type !== "agent" || !p.id) throw forbidden("Agent authentication required");

  const actorAgent = await deps.agentService.getById(p.id);
  if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
    throw forbidden("Agent key cannot access another company");
  }

  if (actorAgent.id === targetAgent.id) return;
  if (actorAgent.role === "ceo") return;
  const allowedByGrant = await deps.access.hasPermission(
    targetAgent.companyId,
    "agent",
    actorAgent.id,
    "agents:create",
  );
  if (allowedByGrant || canCreateAgents(actorAgent)) return;
  throw forbidden("Only CEO or agent creators can modify other agents");
}

export async function resolveCompanyIdForAgentReference(req: Request, db: Db): Promise<string | null> {
  const parsed = optionalCompanyIdQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest("Invalid query", parsed.error.issues);
  }
  const requestedCompanyId = parsed.data.companyId ?? null;
  if (requestedCompanyId) {
    await assertCompanyRead(db, req, requestedCompanyId);
    return requestedCompanyId;
  }
  const p = getCurrentPrincipal(req);
  if (p?.type === "agent" && p.company_id) {
    return p.company_id;
  }
  return null;
}

export async function normalizeAgentReference(
  req: Request,
  rawId: string,
  deps: AgentRoutesCommonDeps,
): Promise<string> {
  const raw = rawId.trim();
  if (isUuidLike(raw)) return raw;

  const companyId = await resolveCompanyIdForAgentReference(req, deps.db);
  if (!companyId) {
    throw unprocessable("Agent shortname lookup requires companyId query parameter");
  }

  const resolved = await deps.agentService.resolveByReference(companyId, raw);
  if (resolved.ambiguous) {
    throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
  }
  if (!resolved.agent) {
    throw notFound("Agent not found");
  }
  return resolved.agent.id;
}

export function parseSourceIssueIds(input: {
  sourceIssueId?: string | null;
  sourceIssueIds?: string[];
}): string[] {
  const values: string[] = [];
  if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
  if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
    values.push(input.sourceIssueId);
  }
  return Array.from(new Set(values));
}
