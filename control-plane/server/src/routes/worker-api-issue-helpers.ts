import type { Db } from "@hive/db";
import { forbidden } from "../errors.js";
import { accessService, agentService, departmentService } from "../services/index.js";
import { canCreateAgents } from "./agents/common.js";

function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
  if (agent.role === "ceo") return true;
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

export async function assertWorkerAgentCanAssignTasks(db: Db, companyId: string, actingAgentId: string) {
  const access = accessService(db);
  const agentsSvc = agentService(db);
  const allowedByGrant = await access.hasPermission(companyId, "agent", actingAgentId, "tasks:assign");
  if (allowedByGrant) return;
  const actorAgent = await agentsSvc.getById(actingAgentId);
  if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
  throw forbidden("Missing permission: tasks:assign");
}

export async function assertWorkerHasAssignScopeOverride(db: Db, companyId: string, actingAgentId: string) {
  return accessService(db).hasPermission(companyId, "agent", actingAgentId, "tasks:assign_scope");
}

export async function assertWorkerIssueDepartmentConstraints(
  db: Db,
  companyId: string,
  actingAgentId: string,
  input: { departmentId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null },
) {
  const departmentsSvc = departmentService(db);
  const access = accessService(db);
  if (input.departmentId) {
    await departmentsSvc.requireCompanyDepartment(companyId, input.departmentId);
  }
  if (!input.departmentId) return;
  const canOverride = await assertWorkerHasAssignScopeOverride(db, companyId, actingAgentId);
  if (canOverride) return;
  if (input.assigneeAgentId) {
    const allowed = await access.canAssignPrincipalToIssueDepartment(
      companyId,
      { principalType: "agent", principalId: input.assigneeAgentId },
      input.departmentId,
    );
    if (!allowed) {
      throw forbidden("Assignee agent is not in the issue department");
    }
  }
  if (input.assigneeUserId) {
    const allowed = await access.canAssignPrincipalToIssueDepartment(
      companyId,
      { principalType: "user", principalId: input.assigneeUserId },
      input.departmentId,
    );
    if (!allowed) {
      throw forbidden("Assignee user is not in the issue department");
    }
  }
}

export async function assertWorkerAgentCanCreateAgents(db: Db, companyId: string, actingAgentId: string) {
  const access = accessService(db);
  const agentsSvc = agentService(db);
  const actorAgent = await agentsSvc.getById(actingAgentId);
  if (!actorAgent || actorAgent.companyId !== companyId) {
    throw forbidden("Agent not in company or not allowed");
  }
  const allowedByGrant = await access.hasPermission(companyId, "agent", actingAgentId, "agents:create");
  if (!allowedByGrant && !canCreateAgents(actorAgent)) {
    throw forbidden("Missing permission: can create agents");
  }
}
