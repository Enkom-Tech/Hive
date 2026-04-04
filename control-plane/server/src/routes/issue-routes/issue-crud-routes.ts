import type { FastifyInstance } from "fastify";
import {
  createIssueSchema,
  listIssuesQuerySchema,
  updateIssueSchema,
  ISSUE_STATUSES_CLOSED,
  ISSUE_STATUS_BACKLOG,
} from "@hive/shared";
import {
  createOrFoldIntent,
  deliverWorkAvailable,
  insertIntentLink,
  logActivity,
  publishLiveEvent,
  WORKABLE_STATUSES_FOR_WEBHOOK,
} from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { HttpError } from "../../errors.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueCrudRoutesF(fastify: FastifyInstance, ctx: IssueRoutesContext): void {
  const { db, svc, heartbeat, projectsSvc, goalsSvc } = ctx;

  fastify.get("/api/issues", (_req, reply) => {
    return reply.status(400).send({ error: "Missing companyId in path. Use /api/companies/{companyId}/issues." });
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/issues", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const parsed = listIssuesQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    const q = parsed.data;
    const p = req.principal ?? null;
    const isBoardList = p?.type === "user" || p?.type === "system";
    const assigneeUserFilterRaw = q.assigneeUserId;
    const touchedByUserFilterRaw = q.touchedByUserId;
    const unreadForUserFilterRaw = q.unreadForUserId;
    const assigneeUserId = assigneeUserFilterRaw === "me" && isBoardList ? p?.id : assigneeUserFilterRaw;
    const touchedByUserId = touchedByUserFilterRaw === "me" && isBoardList ? p?.id : touchedByUserFilterRaw;
    const unreadForUserId = unreadForUserFilterRaw === "me" && isBoardList ? p?.id : unreadForUserFilterRaw;
    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || !isBoardList)) return reply.status(403).send({ error: "assigneeUserId=me requires board authentication" });
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || !isBoardList)) return reply.status(403).send({ error: "touchedByUserId=me requires board authentication" });
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || !isBoardList)) return reply.status(403).send({ error: "unreadForUserId=me requires board authentication" });
    return reply.send(await svc.list(companyId, { status: q.status, assigneeAgentId: q.assigneeAgentId, assigneeUserId, departmentId: q.departmentId, touchedByUserId, unreadForUserId, projectId: q.projectId, parentId: q.parentId, labelId: q.labelId, q: q.q }));
  });

  fastify.get<{ Params: { id: string } }>("/api/issues/:id", async (req, reply) => {
    const rawId = req.params.id;
    const id = await ctx.normalizeIssueIdentifier(rawId);
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    const [ancestors, project, goal, mentionedProjectIds] = await Promise.all([
      svc.getAncestors(issue.id),
      issue.projectId ? projectsSvc.getById(issue.projectId) : null,
      issue.goalId ? goalsSvc.getById(issue.goalId) : !issue.projectId ? goalsSvc.getDefaultCompanyGoal(issue.companyId) : null,
      svc.findMentionedProjectIds(issue.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0 ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds) : [];
    return reply.send({ ...issue, goalId: goal?.id ?? issue.goalId, ancestors, project: project ?? null, goal: goal ?? null, mentionedProjects });
  });

  fastify.post<{ Params: { id: string } }>("/api/issues/:id/read", async (req, reply) => {
    const rawId = req.params.id;
    const id = await ctx.normalizeIssueIdentifier(rawId);
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    const p = req.principal ?? null;
    if (p?.type !== "user" && p?.type !== "system") return reply.status(403).send({ error: "Board authentication required" });
    if (!p?.id) return reply.status(403).send({ error: "Board user context required" });
    const readState = await svc.markRead(issue.companyId, issue.id, p.id, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.read_marked", entityType: "issue", entityId: issue.id, details: { userId: p.id, lastReadAt: readState.lastReadAt } });
    return reply.send(readState);
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/issues", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "issues:write");
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as Record<string, unknown>;
    if (body.assigneeAgentId || body.assigneeUserId) {
      await ctx.assertCanAssignTasksF(req, companyId, body.assigneeAgentId as string | null);
    }
    await ctx.assertIssueDepartmentConstraintsF(req, companyId, { departmentId: body.departmentId as string | null, assigneeAgentId: body.assigneeAgentId as string | null, assigneeUserId: body.assigneeUserId as string | null });
    const actor = getActorInfo(req);
    const intentSource = actor.actorType === "user" ? "board" : actor.actorType === "agent" ? "agent" : "api";
    const rawText = [(body.title as string | undefined), (body.description as string | undefined)].filter(Boolean).join("\n") || (body.title as string) || "";
    const { issue, intentResult } = await db.transaction(async (tx) => {
      const intentRes = await createOrFoldIntent(tx, { companyId, rawText, source: intentSource, intentType: "create_issue", projectId: (body.projectId as string | null) ?? null, goalId: (body.goalId as string | null) ?? null });
      const created = await svc.createInTx(tx, companyId, { ...body as Parameters<typeof svc.createInTx>[2], createdByAgentId: actor.agentId, createdByUserId: actor.actorType === "user" ? actor.actorId : null });
      await insertIntentLink(tx, { intentId: intentRes.intentId, companyId, entityType: "issue", entityId: created.id, linkType: intentRes.folded ? "duplicate" : "primary" });
      return { issue: created, intentResult: intentRes };
    });
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.created", entityType: "issue", entityId: issue.id, details: { title: issue.title, identifier: issue.identifier } });
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: intentResult.folded ? "intent.folded_into_existing" : "intent.created", entityType: "intent", entityId: intentResult.intentId, details: { canonicalKey: intentResult.canonicalKey, folded: intentResult.folded, issueId: issue.id } });
    publishLiveEvent({ companyId, type: intentResult.folded ? "intent.folded" : "intent.created", payload: { intentId: intentResult.intentId, canonicalKey: intentResult.canonicalKey, folded: intentResult.folded, issueId: issue.id, linkType: intentResult.folded ? "duplicate" : "primary" } });
    if (issue.assigneeAgentId && issue.status !== ISSUE_STATUS_BACKLOG) {
      void heartbeat.wakeup(issue.assigneeAgentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: issue.id, mutation: "create" }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: issue.id, source: "issue.create" } })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue create"));
    }
    if (issue.assigneeAgentId && (WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)) {
      void deliverWorkAvailable(issue.assigneeAgentId, issue.companyId, issue.id, db).catch((err) => logger.warn({ err, issueId: issue.id, agentId: issue.assigneeAgentId }, "work_available webhook delivery failed"));
    }
    return reply.status(201).send(issue);
  });

  fastify.patch<{ Params: { id: string } }>("/api/issues/:id", async (req, reply) => {
    const rawId = req.params.id;
    const id = await ctx.normalizeIssueIdentifier(rawId);
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as Record<string, unknown>;
    const p = req.principal ?? null;
    const assigneeWillChange = (body.assigneeAgentId !== undefined && body.assigneeAgentId !== existing.assigneeAgentId) || (body.assigneeUserId !== undefined && body.assigneeUserId !== existing.assigneeUserId);
    const isAgentReturningIssueToCreator = p?.type === "agent" && !!p.id && existing.assigneeAgentId === p.id && body.assigneeAgentId === null && typeof body.assigneeUserId === "string" && !!existing.createdByUserId && body.assigneeUserId === existing.createdByUserId;
    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        const nextAssigneeAgentId = body.assigneeAgentId !== undefined ? (body.assigneeAgentId as string | null) : existing.assigneeAgentId;
        await ctx.assertCanAssignTasksF(req, existing.companyId, nextAssigneeAgentId ?? null);
      }
    }
    await ctx.assertIssueDepartmentConstraintsF(req, existing.companyId, {
      departmentId: body.departmentId === undefined ? existing.departmentId : (body.departmentId as string | null),
      assigneeAgentId: body.assigneeAgentId === undefined ? existing.assigneeAgentId : (body.assigneeAgentId as string | null),
      assigneeUserId: body.assigneeUserId === undefined ? existing.assigneeUserId : (body.assigneeUserId as string | null),
    });
    await ctx.assertAgentRunCheckoutOwnershipF(req, existing);
    const { comment: commentBody, hiddenAt: hiddenAtRaw, ...updateFields } = body;
    const typedUpdateFields = updateFields as Record<string, unknown>;
    if (hiddenAtRaw !== undefined) {
      typedUpdateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw as string) : null;
    }
    let issue;
    try {
      issue = await svc.update(id, typedUpdateFields);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn({ issueId: id, companyId: existing.companyId, assigneePatch: { assigneeAgentId: body.assigneeAgentId === undefined ? "__omitted__" : body.assigneeAgentId, assigneeUserId: body.assigneeUserId === undefined ? "__omitted__" : body.assigneeUserId }, currentAssignee: { assigneeAgentId: existing.assigneeAgentId, assigneeUserId: existing.assigneeUserId }, error: (err as Error).message, details: (err as HttpError).details }, "issue update rejected with 422");
      }
      throw err;
    }
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    if ((ISSUE_STATUSES_CLOSED as readonly string[]).includes(typedUpdateFields.status as string) && existing.executionRunId) {
      void heartbeat.finishRunForIssueClosure(existing.executionRunId, typedUpdateFields.status as "done" | "cancelled").catch((err) => logger.warn({ err, runId: existing.executionRunId }, "finish run for issue closure failed"));
    }
    if (issue.assigneeAgentId && (WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)) {
      void deliverWorkAvailable(issue.assigneeAgentId, issue.companyId, issue.id, db).catch((err) => logger.warn({ err, issueId: issue.id, agentId: issue.assigneeAgentId }, "work_available webhook delivery failed"));
    }
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(typedUpdateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== typedUpdateFields[key]) previous[key] = (existing as Record<string, unknown>)[key];
    }
    const actor = getActorInfo(req);
    const hasFieldChanges = Object.keys(previous).length > 0;
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.updated", entityType: "issue", entityId: issue.id, details: { ...typedUpdateFields, identifier: issue.identifier, ...(commentBody ? { source: "comment" } : {}), _previous: hasFieldChanges ? previous : undefined } });
    let comment = null;
    if (commentBody) {
      comment = await svc.addComment(id, commentBody as string, { agentId: actor.agentId ?? undefined, userId: actor.actorType === "user" ? actor.actorId : undefined });
      await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.comment_added", entityType: "issue", entityId: issue.id, details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), identifier: issue.identifier, issueTitle: issue.title, ...(hasFieldChanges ? { updated: true } : {}) } });
    }
    const assigneeChanged = assigneeWillChange;
    const statusChangedFromBacklog = existing.status === ISSUE_STATUS_BACKLOG && issue.status !== ISSUE_STATUS_BACKLOG && body.status !== undefined;
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      if (assigneeChanged && issue.assigneeAgentId && issue.status !== ISSUE_STATUS_BACKLOG) {
        wakeups.set(issue.assigneeAgentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: issue.id, mutation: "update" }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: issue.id, source: "issue.update" } });
      }
      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId) {
        wakeups.set(issue.assigneeAgentId, { source: "automation", triggerDetail: "system", reason: "issue_status_changed", payload: { issueId: issue.id, mutation: "update" }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: issue.id, source: "issue.status_change" } });
      }
      if (commentBody && comment) {
        let mentionedIds: string[] = [];
        try { mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody as string); } catch (err) { logger.warn({ err, issueId: id }, "failed to resolve @-mentions"); }
        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, { source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned", payload: { issueId: id, commentId: comment.id }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: id, taskId: id, commentId: comment.id, wakeCommentId: comment.id, wakeReason: "issue_comment_mentioned", source: "comment.mention" } });
        }
      }
      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat.wakeup(agentId, wakeup).catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();
    return reply.send({ ...issue, comment });
  });

  fastify.delete<{ Params: { id: string } }>("/api/issues/:id", async (req, reply) => {
    const rawId = req.params.id;
    const id = await ctx.normalizeIssueIdentifier(rawId);
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    const attachments = await svc.listAttachments(id);
    const issue = await svc.remove(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    for (const attachment of attachments) {
      try { await ctx.storage.deleteObject(attachment.companyId, attachment.objectKey); }
      catch (err) { logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete"); }
    }
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.deleted", entityType: "issue", entityId: issue.id });
    return reply.send(issue);
  });
}
