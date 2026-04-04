import type { FastifyInstance } from "fastify";
import {
  addIssueCommentSchema,
  ISSUE_STATUSES_CLOSED,
  ISSUE_STATUS_TODO,
} from "@hive/shared";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { logActivity } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueCommentsRoutesF(fastify: FastifyInstance, ctx: IssueRoutesContext): void {
  const { db, svc, heartbeat } = ctx;

  fastify.get<{ Params: { id: string } }>("/api/issues/:id/comments", async (req, reply) => {
    const { id } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    return reply.send(await svc.listComments(id));
  });

  fastify.get<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId", async (req, reply) => {
    const { id, commentId } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) return reply.status(404).send({ error: "Comment not found" });
    return reply.send(comment);
  });

  fastify.post<{ Params: { id: string } }>("/api/issues/:id/comments", async (req, reply) => {
    const { id } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyPermission(db, req, issue.companyId, "activity:write");
    await ctx.assertAgentRunCheckoutOwnershipF(req, issue);
    const parsed = addIssueCommentSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as { body: string; reopen?: boolean; interrupt?: boolean };
    const actor = getActorInfo(req);
    const p = req.principal ?? null;
    const reopenRequested = body.reopen === true;
    const interruptRequested = body.interrupt === true;
    const isClosed = (ISSUE_STATUSES_CLOSED as readonly string[]).includes(issue.status);
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;

    if (reopenRequested && isClosed) {
      const reopenedIssue = await svc.update(id, { status: ISSUE_STATUS_TODO });
      if (!reopenedIssue) return reply.status(404).send({ error: "Issue not found" });
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;
      await logActivity(db, { companyId: currentIssue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.updated", entityType: "issue", entityId: currentIssue.id, details: { status: ISSUE_STATUS_TODO, reopened: true, reopenedFrom: reopenFromStatus, source: "comment", identifier: currentIssue.identifier } });
    }

    if (interruptRequested) {
      if (p?.type !== "user" && p?.type !== "system") return reply.status(403).send({ error: "Only board users can interrupt active runs from issue comments" });
      let runToInterrupt = currentIssue.executionRunId ? await heartbeat.getRun(currentIssue.executionRunId) : null;
      if ((!runToInterrupt || runToInterrupt.status !== "running") && currentIssue.assigneeAgentId) {
        const activeRun = await heartbeat.getActiveRunForAgent(currentIssue.assigneeAgentId);
        const activeIssueId = activeRun && activeRun.contextSnapshot && typeof activeRun.contextSnapshot === "object" && typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string" ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string) : null;
        if (activeRun && activeRun.status === "running" && activeIssueId === currentIssue.id) runToInterrupt = activeRun;
      }
      if (runToInterrupt && runToInterrupt.status === "running") {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, { companyId: cancelled.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: cancelled.id, details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id } });
        }
      }
    }

    const comment = await svc.addComment(id, body.body, { agentId: actor.agentId ?? undefined, userId: actor.actorType === "user" ? actor.actorId : undefined });
    await logActivity(db, { companyId: currentIssue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.comment_added", entityType: "issue", entityId: currentIssue.id, details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), identifier: currentIssue.identifier, issueTitle: currentIssue.title, ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}), ...(interruptedRunId ? { interruptedRunId } : {}) } });

    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, { source: "automation", triggerDetail: "system", reason: "issue_reopened_via_comment", payload: { issueId: currentIssue.id, commentId: comment.id, reopenedFrom: reopenFromStatus, mutation: "comment", ...(interruptedRunId ? { interruptedRunId } : {}) }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: currentIssue.id, taskId: currentIssue.id, commentId: comment.id, source: "issue.comment.reopen", wakeReason: "issue_reopened_via_comment", reopenedFrom: reopenFromStatus, ...(interruptedRunId ? { interruptedRunId } : {}) } });
        } else {
          wakeups.set(assigneeId, { source: "automation", triggerDetail: "system", reason: "issue_commented", payload: { issueId: currentIssue.id, commentId: comment.id, mutation: "comment", ...(interruptedRunId ? { interruptedRunId } : {}) }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: currentIssue.id, taskId: currentIssue.id, commentId: comment.id, source: "issue.comment", wakeReason: "issue_commented", ...(interruptedRunId ? { interruptedRunId } : {}) } });
        }
      }
      let mentionedIds: string[] = [];
      try { mentionedIds = await svc.findMentionedAgents(issue.companyId, body.body); } catch (err) { logger.warn({ err, issueId: id }, "failed to resolve @-mentions"); }
      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, { source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned", payload: { issueId: id, commentId: comment.id }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: id, taskId: id, commentId: comment.id, wakeCommentId: comment.id, wakeReason: "issue_comment_mentioned", source: "comment.mention" } });
      }
      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat.wakeup(agentId, wakeup).catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    return reply.status(201).send(comment);
  });
}
