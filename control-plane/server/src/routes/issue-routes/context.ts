import type { Db } from "@hive/db";
import type { StorageService } from "../../storage/types.js";
import { isLocalImplicit } from "../../auth/principal.js";
import {
  accessService,
  agentService,
  departmentService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  projectService,
} from "../../services/index.js";
import { forbidden, unauthorized } from "../../errors.js";
import { assertCompanyRead, getActorInfo, type PrincipalCarrier } from "../authz.js";
import { ISSUE_STATUS_IN_PROGRESS } from "@hive/shared";

export type IssueRoutesContext = ReturnType<typeof createIssueRoutesContext>;

export function createIssueRoutesContext(db: Db, storage: StorageService) {
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const agentsSvc = agentService(db);
  const departmentsSvc = departmentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  /**
   * Fastify-compatible: throws an error instead of writing to res.
   * Returns the principal's run id (if agent), or null.
   */
  function requireAgentRunIdF(req: PrincipalCarrier): string | null {
    const p = req.principal ?? null;
    if (p?.type !== "agent") return null;
    const runId = p.runId?.trim();
    if (runId) return runId;
    throw unauthorized("Agent run id required");
  }

  /**
   * Fastify-compatible: throws forbidden instead of writing to res.
   */
  async function assertCanManageIssueApprovalLinksF(req: PrincipalCarrier, companyId: string): Promise<void> {
    await assertCompanyRead(db, req, companyId);
    const p = req.principal ?? null;
    if (p?.type === "user" || p?.type === "system") {
      if (p?.type === "system" || isLocalImplicit(req)) return;
      if (p?.roles?.includes("instance_admin")) return;
      const ok = await access.canUser(companyId, p.id ?? "", "approvals:act");
      if (!ok) throw forbidden("Missing permission: approvals:act");
      return;
    }
    if (!p?.id || p?.type !== "agent") throw forbidden("Agent authentication required");
    const actorAgent = await agentsSvc.getById(p.id);
    if (!actorAgent || actorAgent.companyId !== companyId) throw forbidden("Forbidden");
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return;
    throw forbidden("Missing permission to link approvals");
  }

  async function assertCanAssignTasksF(req: PrincipalCarrier, companyId: string, assigneeAgentId?: string | null): Promise<void> {
    await assertCompanyRead(db, req, companyId);
    const p = req.principal ?? null;
    if (p?.type === "user" || p?.type === "system") {
      if (p?.type === "system" || p?.roles?.includes("instance_admin")) return;
      if (assigneeAgentId) {
        const ok = await access.canPrincipalAssignAgent(companyId, "user", p?.id ?? "", assigneeAgentId);
        if (!ok) throw forbidden("Missing permission to assign to this agent");
        return;
      }
      const allowed = await access.canUser(companyId, p?.id ?? "", "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (p?.type === "agent") {
      if (!p.id) throw forbidden("Agent authentication required");
      if (assigneeAgentId) {
        const ok = await access.canPrincipalAssignAgent(companyId, "agent", p.id, assigneeAgentId);
        if (!ok) throw forbidden("Missing permission to assign to this agent");
        return;
      }
      const allowedByGrant = await access.hasPermission(companyId, "agent", p.id, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(p.id);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  async function hasAssignScopeOverrideF(req: PrincipalCarrier, companyId: string): Promise<boolean> {
    const p = req.principal ?? null;
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return true;
    if (p?.type === "user") return access.canUser(companyId, p.id ?? "", "tasks:assign_scope");
    if (p?.type === "agent") {
      if (!p.id) return false;
      return access.hasPermission(companyId, "agent", p.id, "tasks:assign_scope");
    }
    return false;
  }

  async function assertIssueDepartmentConstraintsF(
    req: PrincipalCarrier,
    companyId: string,
    input: { departmentId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null },
  ) {
    if (input.departmentId) {
      await departmentsSvc.requireCompanyDepartment(companyId, input.departmentId);
    }
    if (!input.departmentId) return;
    const canOverride = await hasAssignScopeOverrideF(req, companyId);
    if (canOverride) return;
    if (input.assigneeAgentId) {
      const allowed = await access.canAssignPrincipalToIssueDepartment(
        companyId,
        { principalType: "agent", principalId: input.assigneeAgentId },
        input.departmentId,
      );
      if (!allowed) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: "issue.assignment_denied_department_mismatch", entityType: "issue", entityId: "__pending__",
          details: { reason: "assignee_agent_department_mismatch", departmentId: input.departmentId, assigneeAgentId: input.assigneeAgentId },
        });
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
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: "issue.assignment_denied_department_mismatch", entityType: "issue", entityId: "__pending__",
          details: { reason: "assignee_user_department_mismatch", departmentId: input.departmentId, assigneeUserId: input.assigneeUserId },
        });
        throw forbidden("Assignee user is not in the issue department");
      }
    }
  }

  /**
   * Fastify-compatible: throws instead of writing to res. Returns true if ownership is verified.
   */
  async function assertAgentRunCheckoutOwnershipF(
    req: PrincipalCarrier,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ): Promise<void> {
    const p = req.principal ?? null;
    if (p?.type !== "agent") return;
    const actorAgentId = p.id;
    if (!actorAgentId) throw forbidden("Agent authentication required");
    if (issue.status !== ISSUE_STATUS_IN_PROGRESS || issue.assigneeAgentId !== actorAgentId) return;
    const runId = requireAgentRunIdF(req);
    if (!runId) throw unauthorized("Agent run id required");
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId,
        agentId: actor.agentId, runId: actor.runId, action: "issue.checkout_lock_adopted",
        entityType: "issue", entityId: issue.id,
        details: { previousCheckoutRunId: ownership.adoptedFromRunId, checkoutRunId: runId, reason: "stale_checkout_run" },
      });
    }
  }

  return {
    db,
    storage,
    svc,
    access,
    heartbeat,
    agentsSvc,
    departmentsSvc,
    projectsSvc,
    goalsSvc,
    issueApprovalsSvc,
    withContentPath,
    normalizeIssueIdentifier,
    requireAgentRunIdF,
    assertCanManageIssueApprovalLinksF,
    assertCanAssignTasksF,
    assertIssueDepartmentConstraintsF,
    assertAgentRunCheckoutOwnershipF,
  };
}
