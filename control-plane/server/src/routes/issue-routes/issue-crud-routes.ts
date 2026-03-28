import type { Router } from "express";
import {
  createIssueSchema,
  listIssuesQuerySchema,
  updateIssueSchema,
  ISSUE_STATUSES_CLOSED,
  ISSUE_STATUS_BACKLOG,
} from "@hive/shared";
import { validate } from "../../middleware/validate.js";
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
import { getCurrentPrincipal } from "../../auth/principal.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueCrudRoutes(router: Router, ctx: IssueRoutesContext): void {
  const { db, svc, heartbeat, projectsSvc, goalsSvc } = ctx;

  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const parsed = listIssuesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    const assigneeUserFilterRaw = q.assigneeUserId;
    const touchedByUserFilterRaw = q.touchedByUserId;
    const unreadForUserFilterRaw = q.unreadForUserId;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && (getCurrentPrincipal(req)?.type === "user" || getCurrentPrincipal(req)?.type === "system")
        ? getCurrentPrincipal(req)?.id
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && (getCurrentPrincipal(req)?.type === "user" || getCurrentPrincipal(req)?.type === "system")
        ? getCurrentPrincipal(req)?.id
        : touchedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && (getCurrentPrincipal(req)?.type === "user" || getCurrentPrincipal(req)?.type === "system")
        ? getCurrentPrincipal(req)?.id
        : unreadForUserFilterRaw;

    const pList = getCurrentPrincipal(req);
    const isBoardList = pList?.type === "user" || pList?.type === "system";
    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || !isBoardList)) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || !isBoardList)) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || !isBoardList)) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }

    const result = await svc.list(companyId, {
      status: q.status,
      assigneeAgentId: q.assigneeAgentId,
      assigneeUserId,
      departmentId: q.departmentId,
      touchedByUserId,
      unreadForUserId,
      projectId: q.projectId,
      parentId: q.parentId,
      labelId: q.labelId,
      q: q.q,
    });
    res.json(result);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyRead(db, req, issue.companyId);
    const [ancestors, project, goal, mentionedProjectIds] = await Promise.all([
      svc.getAncestors(issue.id),
      issue.projectId ? projectsSvc.getById(issue.projectId) : null,
      issue.goalId
        ? goalsSvc.getById(issue.goalId)
        : !issue.projectId
          ? goalsSvc.getDefaultCompanyGoal(issue.companyId)
          : null,
      svc.findMentionedProjectIds(issue.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    res.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
    });
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyRead(db, req, issue.companyId);
    const pMark = getCurrentPrincipal(req);
    if (pMark?.type !== "user" && pMark?.type !== "system") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!pMark?.id) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, pMark.id, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: pMark.id, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "issues:write");
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await ctx.assertCanAssignTasks(req, companyId, req.body.assigneeAgentId ?? null);
    }
    await ctx.assertIssueDepartmentConstraints(req, companyId, {
      departmentId: req.body.departmentId,
      assigneeAgentId: req.body.assigneeAgentId,
      assigneeUserId: req.body.assigneeUserId,
    });

    const actor = getActorInfo(req);
    const intentSource = actor.actorType === "user" ? "board" : actor.actorType === "agent" ? "agent" : "api";
    const rawText = [req.body.title, req.body.description].filter(Boolean).join("\n") || req.body.title || "";

    const { issue, intentResult } = await db.transaction(async (tx) => {
      const intentRes = await createOrFoldIntent(tx, {
        companyId,
        rawText,
        source: intentSource,
        intentType: "create_issue",
        projectId: req.body.projectId ?? null,
        goalId: req.body.goalId ?? null,
      });
      const created = await svc.createInTx(tx, companyId, {
        ...req.body,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await insertIntentLink(tx, {
        intentId: intentRes.intentId,
        companyId,
        entityType: "issue",
        entityId: created.id,
        linkType: intentRes.folded ? "duplicate" : "primary",
      });
      return { issue: created, intentResult: intentRes };
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier },
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: intentResult.folded ? "intent.folded_into_existing" : "intent.created",
      entityType: "intent",
      entityId: intentResult.intentId,
      details: {
        canonicalKey: intentResult.canonicalKey,
        folded: intentResult.folded,
        issueId: issue.id,
      },
    });

    publishLiveEvent({
      companyId,
      type: intentResult.folded ? "intent.folded" : "intent.created",
      payload: {
        intentId: intentResult.intentId,
        canonicalKey: intentResult.canonicalKey,
        folded: intentResult.folded,
        issueId: issue.id,
        linkType: intentResult.folded ? "duplicate" : "primary",
      },
    });

    if (issue.assigneeAgentId && issue.status !== ISSUE_STATUS_BACKLOG) {
      void heartbeat
        .wakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: issue.id, mutation: "create" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.create" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue create"));
    }
    if (
      issue.assigneeAgentId &&
      (WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)
    ) {
      void deliverWorkAvailable(issue.assigneeAgentId, issue.companyId, issue.id, db).catch((err) =>
        logger.warn({ err, issueId: issue.id, agentId: issue.assigneeAgentId }, "work_available webhook delivery failed"),
      );
    }

    res.status(201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);

    const isAgentReturningIssueToCreator =
      getCurrentPrincipal(req)?.type === "agent" &&
      !!getCurrentPrincipal(req)?.id &&
      existing.assigneeAgentId === getCurrentPrincipal(req)?.id &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        const nextAssigneeAgentId =
          req.body.assigneeAgentId !== undefined ? req.body.assigneeAgentId : existing.assigneeAgentId;
        await ctx.assertCanAssignTasks(req, existing.companyId, nextAssigneeAgentId ?? null);
      }
    }
    await ctx.assertIssueDepartmentConstraints(req, existing.companyId, {
      departmentId: req.body.departmentId === undefined ? existing.departmentId : req.body.departmentId,
      assigneeAgentId: req.body.assigneeAgentId === undefined ? existing.assigneeAgentId : req.body.assigneeAgentId,
      assigneeUserId: req.body.assigneeUserId === undefined ? existing.assigneeUserId : req.body.assigneeUserId,
    });
    if (!(await ctx.assertAgentRunCheckoutOwnership(req, res, existing))) return;

    const { comment: commentBody, hiddenAt: hiddenAtRaw, ...updateFields } = req.body;
    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    let issue;
    try {
      issue = await svc.update(id, updateFields);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    if (
      (ISSUE_STATUSES_CLOSED as readonly string[]).includes(updateFields.status) &&
      existing.executionRunId
    ) {
      void heartbeat
        .finishRunForIssueClosure(existing.executionRunId, updateFields.status)
        .catch((err) =>
          logger.warn(
            { err, runId: existing.executionRunId },
            "finish run for issue closure failed",
          ),
        );
    }
    if (
      issue.assigneeAgentId &&
      (WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)
    ) {
      void deliverWorkAvailable(issue.assigneeAgentId, issue.companyId, issue.id, db).catch((err) =>
        logger.warn({ err, issueId: issue.id, agentId: issue.assigneeAgentId }, "work_available webhook delivery failed"),
      );
    }

    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }

    const actor = getActorInfo(req);
    const hasFieldChanges = Object.keys(previous).length > 0;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        _previous: hasFieldChanges ? previous : undefined,
      },
    });

    let comment = null;
    if (commentBody) {
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

    }

    const assigneeChanged = assigneeWillChange;
    const statusChangedFromBacklog =
      existing.status === ISSUE_STATUS_BACKLOG &&
      issue.status !== ISSUE_STATUS_BACKLOG &&
      req.body.status !== undefined;

    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

      if (assigneeChanged && issue.assigneeAgentId && issue.status !== ISSUE_STATUS_BACKLOG) {
        wakeups.set(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: issue.id, mutation: "update" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.update" },
        });
      }

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId) {
        wakeups.set(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: { issueId: issue.id, mutation: "update" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.status_change" },
        });
      }

      if (commentBody && comment) {
        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({ ...issue, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await ctx.storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });
}
