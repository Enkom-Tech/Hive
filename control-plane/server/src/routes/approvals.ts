import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  listApprovalsQuerySchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@hive/shared";
import { logger } from "../middleware/logger.js";
import type { ApprovalServiceAdapterDeps } from "../services/approvals.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../adapters/index.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export async function approvalsPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; strictSecretsMode: boolean },
): Promise<void> {
  const { db, strictSecretsMode } = opts;
  const secretsSvc = secretService(db);
  const adapterDeps: ApprovalServiceAdapterDeps = {
    secretService: secretsSvc,
    assertAdapterTypeAllowed,
    validateAdapterConfig,
    getStrictSecretsMode: () => strictSecretsMode,
  };
  const svc = approvalService(db, adapterDeps);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);

  fastify.get<{ Params: { companyId: string }; Querystring: Record<string, unknown> }>(
    "/api/companies/:companyId/approvals",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      const parsed = listApprovalsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
      const result = await svc.list(companyId, parsed.data.status);
      return reply.send(result.map(redactApprovalPayload));
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/approvals/:id", async (req, reply) => {
    const approval = await svc.getById(req.params.id);
    if (!approval) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyRead(db, req, approval.companyId);
    return reply.send(redactApprovalPayload(approval));
  });

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/approvals",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      const parsed = createApprovalSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const rawIssueIds = (parsed.data as { issueIds?: unknown }).issueIds;
      const issueIds = Array.isArray(rawIssueIds) ? rawIssueIds.filter((v: unknown): v is string => typeof v === "string") : [];
      const uniqueIssueIds = Array.from(new Set(issueIds));
      const { issueIds: _issueIds, ...approvalInput } = parsed.data as typeof parsed.data & { issueIds?: unknown[] };
      const normalizedPayload =
        approvalInput.type === "hire_agent"
          ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(companyId, approvalInput.payload, { strictMode: strictSecretsMode })
          : approvalInput.payload;
      const actor = getActorInfo(req);
      const approval = await svc.create(companyId, {
        ...approvalInput,
        payload: normalizedPayload,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId: approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      if (uniqueIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null });
      }
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "approval.created", entityType: "approval", entityId: approval.id, details: { type: approval.type, issueIds: uniqueIssueIds } });
      return reply.status(201).send(redactApprovalPayload(approval));
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/approvals/:id/issues", async (req, reply) => {
    const approval = await svc.getById(req.params.id);
    if (!approval) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyRead(db, req, approval.companyId);
    return reply.send(await issueApprovalsSvc.listIssuesForApproval(req.params.id));
  });

  fastify.post<{ Params: { id: string } }>("/api/approvals/:id/approve", async (req, reply) => {
    const pre = await svc.getById(req.params.id);
    if (!pre) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyPermission(db, req, pre.companyId, "approvals:act");
    const parsed = resolveApprovalSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
    const { approval, applied } = await svc.approve(req.params.id, parsed.data.decidedByUserId ?? "board", parsed.data.decisionNote);
    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;
      const actorId = req.principal?.id ?? "board";
      await logActivity(db, { companyId: approval.companyId, actorType: "user", actorId, action: "approval.approved", entityType: "approval", entityId: approval.id, details: { type: approval.type, requestedByAgentId: approval.requestedByAgentId, linkedIssueIds } });
      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: { approvalId: approval.id, approvalStatus: approval.status, issueId: primaryIssueId, issueIds: linkedIssueIds },
            requestedByActorType: "user",
            requestedByActorId: actorId,
            contextSnapshot: { source: "approval.approved", approvalId: approval.id, approvalStatus: approval.status, issueId: primaryIssueId, issueIds: linkedIssueIds, taskId: primaryIssueId, wakeReason: "approval_approved" },
          });
          await logActivity(db, { companyId: approval.companyId, actorType: "user", actorId, action: "approval.requester_wakeup_queued", entityType: "approval", entityId: approval.id, details: { requesterAgentId: approval.requestedByAgentId, wakeRunId: wakeRun?.id ?? null, linkedIssueIds } });
        } catch (err) {
          logger.warn({ err, approvalId: approval.id, requestedByAgentId: approval.requestedByAgentId }, "failed to queue requester wakeup after approval");
          await logActivity(db, { companyId: approval.companyId, actorType: "user", actorId, action: "approval.requester_wakeup_failed", entityType: "approval", entityId: approval.id, details: { requesterAgentId: approval.requestedByAgentId, linkedIssueIds, error: err instanceof Error ? err.message : String(err) } });
        }
      }
    }
    return reply.send(redactApprovalPayload(approval));
  });

  fastify.post<{ Params: { id: string } }>("/api/approvals/:id/reject", async (req, reply) => {
    const pre = await svc.getById(req.params.id);
    if (!pre) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyPermission(db, req, pre.companyId, "approvals:act");
    const parsed = resolveApprovalSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
    const { approval, applied } = await svc.reject(req.params.id, parsed.data.decidedByUserId ?? "board", parsed.data.decisionNote);
    if (applied) {
      await logActivity(db, { companyId: approval.companyId, actorType: "user", actorId: req.principal?.id ?? "board", action: "approval.rejected", entityType: "approval", entityId: approval.id, details: { type: approval.type } });
    }
    return reply.send(redactApprovalPayload(approval));
  });

  fastify.post<{ Params: { id: string } }>("/api/approvals/:id/request-revision", async (req, reply) => {
    const pre = await svc.getById(req.params.id);
    if (!pre) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyPermission(db, req, pre.companyId, "approvals:act");
    const parsed = requestApprovalRevisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
    const approval = await svc.requestRevision(req.params.id, parsed.data.decidedByUserId ?? "board", parsed.data.decisionNote);
    await logActivity(db, { companyId: approval.companyId, actorType: "user", actorId: req.principal?.id ?? "board", action: "approval.revision_requested", entityType: "approval", entityId: approval.id, details: { type: approval.type } });
    return reply.send(redactApprovalPayload(approval));
  });

  fastify.post<{ Params: { id: string } }>("/api/approvals/:id/resubmit", async (req, reply) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyRead(db, req, existing.companyId);
    const p = req.principal;
    if (p?.type === "agent" && p.id !== existing.requestedByAgentId) return reply.status(403).send({ error: "Only requesting agent can resubmit this approval" });
    const parsed = resubmitApprovalSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
    const normalizedPayload = parsed.data.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(existing.companyId, parsed.data.payload, { strictMode: strictSecretsMode })
        : parsed.data.payload
      : undefined;
    const approval = await svc.resubmit(req.params.id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: approval.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "approval.resubmitted", entityType: "approval", entityId: approval.id, details: { type: approval.type } });
    return reply.send(redactApprovalPayload(approval));
  });

  fastify.get<{ Params: { id: string } }>("/api/approvals/:id/comments", async (req, reply) => {
    const approval = await svc.getById(req.params.id);
    if (!approval) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyRead(db, req, approval.companyId);
    return reply.send(await svc.listComments(req.params.id));
  });

  fastify.post<{ Params: { id: string } }>("/api/approvals/:id/comments", async (req, reply) => {
    const approval = await svc.getById(req.params.id);
    if (!approval) return reply.status(404).send({ error: "Approval not found" });
    await assertCompanyRead(db, req, approval.companyId);
    const parsed = addApprovalCommentSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
    const actor = getActorInfo(req);
    const comment = await svc.addComment(req.params.id, parsed.data.body, { agentId: actor.agentId ?? undefined, userId: actor.actorType === "user" ? actor.actorId : undefined });
    await logActivity(db, { companyId: approval.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "approval.comment_added", entityType: "approval", entityId: approval.id, details: { commentId: comment.id } });
    return reply.status(201).send(comment);
  });
}
