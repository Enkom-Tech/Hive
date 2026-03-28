import type { Request, Response } from "express";
import multer from "multer";
import type { Db } from "@hive/db";
import type { StorageService } from "../../storage/types.js";
import { getCurrentPrincipal, isLocalImplicit } from "../../auth/principal.js";
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
import { assertCompanyRead, getActorInfo } from "../authz.js";
import { ISSUE_STATUS_IN_PROGRESS } from "@hive/shared";
import { getMaxAttachmentBytes } from "../../attachment-types.js";

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
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getMaxAttachmentBytes(), files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    await assertCompanyRead(db, req, companyId);
    const p = getCurrentPrincipal(req);
    if (p?.type === "user" || p?.type === "system") {
      if (p?.type === "system" || isLocalImplicit(req)) return true;
      if (p?.roles?.includes("instance_admin")) return true;
      const ok = await access.canUser(companyId, p.id ?? "", "approvals:act");
      if (!ok) {
        res.status(403).json({ error: "Missing permission: approvals:act" });
        return false;
      }
      return true;
    }
    if (!p?.id || p?.type !== "agent") {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(p.id);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string, assigneeAgentId?: string | null) {
    await assertCompanyRead(db, req, companyId);
    const p = getCurrentPrincipal(req);
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

  async function hasAssignScopeOverride(req: Request, companyId: string): Promise<boolean> {
    const p = getCurrentPrincipal(req);
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return true;
    if (p?.type === "user") return access.canUser(companyId, p.id ?? "", "tasks:assign_scope");
    if (p?.type === "agent") {
      if (!p.id) return false;
      return access.hasPermission(companyId, "agent", p.id, "tasks:assign_scope");
    }
    return false;
  }

  async function assertIssueDepartmentConstraints(
    req: Request,
    companyId: string,
    input: { departmentId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null },
  ) {
    if (input.departmentId) {
      await departmentsSvc.requireCompanyDepartment(companyId, input.departmentId);
    }
    if (!input.departmentId) return;
    const canOverride = await hasAssignScopeOverride(req, companyId);
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
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.assignment_denied_department_mismatch",
          entityType: "issue",
          entityId: "__pending__",
          details: {
            reason: "assignee_agent_department_mismatch",
            departmentId: input.departmentId,
            assigneeAgentId: input.assigneeAgentId,
          },
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
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.assignment_denied_department_mismatch",
          entityType: "issue",
          entityId: "__pending__",
          details: {
            reason: "assignee_user_department_mismatch",
            departmentId: input.departmentId,
            assigneeUserId: input.assigneeUserId,
          },
        });
        throw forbidden("Assignee user is not in the issue department");
      }
    }
  }

  function requireAgentRunId(req: Request, res: Response) {
    const p = getCurrentPrincipal(req);
    if (p?.type !== "agent") return null;
    const runId = p.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    const p = getCurrentPrincipal(req);
    if (p?.type !== "agent") return true;
    const actorAgentId = p.id;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== ISSUE_STATUS_IN_PROGRESS || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
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
    upload,
    withContentPath,
    runSingleFileUpload,
    assertCanManageIssueApprovalLinks,
    assertCanAssignTasks,
    hasAssignScopeOverride,
    assertIssueDepartmentConstraints,
    requireAgentRunId,
    assertAgentRunCheckoutOwnership,
    normalizeIssueIdentifier,
  };
}
