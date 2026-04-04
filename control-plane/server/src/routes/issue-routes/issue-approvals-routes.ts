import type { FastifyInstance } from "fastify";
import { linkIssueApprovalSchema } from "@hive/shared";
import { assertCompanyRead, getActorInfo } from "../authz.js";
import { logActivity } from "../../services/index.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueApprovalsRoutesF(fastify: FastifyInstance, ctx: IssueRoutesContext): void {
  const { db, svc, issueApprovalsSvc } = ctx;

  fastify.get<{ Params: { id: string } }>("/api/issues/:id/approvals", async (req, reply) => {
    const { id } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    return reply.send(await issueApprovalsSvc.listApprovalsForIssue(id));
  });

  fastify.get<{ Params: { id: string } }>("/api/issues/:id/quality-review", async (req, reply) => {
    const { id } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    return reply.send(approvals.find((a) => a.type === "quality_review") ?? null);
  });

  fastify.post<{ Params: { id: string } }>("/api/issues/:id/approvals", async (req, reply) => {
    const { id } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    const parsed = linkIssueApprovalSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await ctx.assertCanManageIssueApprovalLinksF(req, issue.companyId);
    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, parsed.data.approvalId, { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null });
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.approval_linked", entityType: "issue", entityId: issue.id, details: { approvalId: parsed.data.approvalId } });
    return reply.status(201).send(await issueApprovalsSvc.listApprovalsForIssue(id));
  });

  fastify.delete<{ Params: { id: string; approvalId: string } }>("/api/issues/:id/approvals/:approvalId", async (req, reply) => {
    const { id, approvalId } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await ctx.assertCanManageIssueApprovalLinksF(req, issue.companyId);
    await issueApprovalsSvc.unlink(id, approvalId);
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.approval_unlinked", entityType: "issue", entityId: issue.id, details: { approvalId } });
    return reply.send({ ok: true });
  });
}
