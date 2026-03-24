import { Router } from "express";
import type { Db } from "@hive/db";
import {
  createCostEventSchema,
  ISSUE_STATUSES,
  ISSUE_STATUS_IN_PROGRESS,
} from "@hive/shared";
import { z } from "zod";
import { getCurrentPrincipal } from "../auth/principal.js";
import { costService, issueService, logActivity } from "../services/index.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { HttpError } from "../errors.js";

/** Canonical tool-bridge action ids (must match server allowlist env, case-insensitive). */
export const WORKER_TOOL_BRIDGE_ACTIONS = {
  costReport: "cost.report",
  issueAppendComment: "issue.appendComment",
  issueTransitionStatus: "issue.transitionStatus",
  issueGet: "issue.get",
} as const;

const bridgeBodySchema = z.object({
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
});

const issueAppendInputSchema = z.object({
  issueId: z.string().min(1),
  body: z.string().min(1).max(256_000),
});

const issueStatuses = ISSUE_STATUSES as readonly string[];

const issueTransitionInputSchema = z.object({
  issueId: z.string().min(1),
  status: z
    .string()
    .min(1)
    .refine((s) => issueStatuses.includes(s), { message: "Invalid issue status" }),
});

const issueGetInputSchema = z.object({
  issueId: z.string().min(1),
});

function normalizeActionId(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseAllowedActions(raw: string[]): string[] {
  return raw.map((a) => normalizeActionId(a)).filter(Boolean);
}

export function workerToolRoutes(
  db: Db,
  opts: { allowedActions: string[] },
): Router {
  const router = Router();
  const costs = costService(db);
  const issues = issueService(db);
  const allowedSet = new Set(parseAllowedActions(opts.allowedActions));

  router.post("/bridge", validate(bridgeBodySchema), async (req, res) => {
    const p = getCurrentPrincipal(req);
    if (!p) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (p.type !== "agent" || !p.id || !p.company_id) {
      res.status(403).json({ error: "Agent authentication required" });
      return;
    }
    if (allowedSet.size === 0) {
      res.status(503).json({ error: "Worker tool bridge is not enabled" });
      return;
    }

    const { action, input } = req.body as z.infer<typeof bridgeBodySchema>;
    const actionId = normalizeActionId(action);
    if (!allowedSet.has(actionId)) {
      res.status(403).json({ error: "Action not allowed" });
      return;
    }

    const companyId = p.company_id;
    try {
      assertCompanyAccess(req, companyId);
    } catch {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const actor = getActorInfo(req);

    try {
      if (actionId === normalizeActionId(WORKER_TOOL_BRIDGE_ACTIONS.costReport)) {
        const parsed = createCostEventSchema.safeParse({
          ...(input ?? {}),
          agentId: p.id,
        });
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
          return;
        }
        const body = parsed.data;
        const event = await costs.createEvent(companyId, {
          agentId: body.agentId,
          issueId: body.issueId ?? null,
          projectId: body.projectId ?? null,
          goalId: body.goalId ?? null,
          billingCode: body.billingCode ?? null,
          provider: body.provider,
          model: body.model,
          inputTokens: body.inputTokens,
          outputTokens: body.outputTokens,
          costCents: body.costCents,
          occurredAt: new Date(body.occurredAt),
        });
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "worker.tool_bridge",
          entityType: "cost_event",
          entityId: event.id,
          details: { bridgeAction: WORKER_TOOL_BRIDGE_ACTIONS.costReport },
        });
        res.status(200).json({ ok: true, result: { costEventId: event.id } });
        return;
      }

      if (actionId === normalizeActionId(WORKER_TOOL_BRIDGE_ACTIONS.issueAppendComment)) {
        const parsedIn = issueAppendInputSchema.safeParse(input ?? {});
        if (!parsedIn.success) {
          res.status(400).json({ error: "Invalid input", details: parsedIn.error.flatten() });
          return;
        }
        let issue = await issues.getById(parsedIn.data.issueId);
        if (!issue && /^[A-Z]+-\d+$/i.test(parsedIn.data.issueId.trim())) {
          issue = await issues.getByIdentifier(parsedIn.data.issueId.trim());
        }
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }

        if (
          issue.status === ISSUE_STATUS_IN_PROGRESS &&
          issue.assigneeAgentId === p.id
        ) {
          const runId = p.runId?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(issue.id, p.id, runId);
        }

        const comment = await issues.addComment(issue.id, parsedIn.data.body, {
          agentId: p.id,
        });
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "worker.tool_bridge",
          entityType: "issue_comment",
          entityId: comment.id,
          details: {
            bridgeAction: WORKER_TOOL_BRIDGE_ACTIONS.issueAppendComment,
            issueId: issue.id,
          },
        });
        res.status(200).json({ ok: true, result: { commentId: comment.id, issueId: issue.id } });
        return;
      }

      if (actionId === normalizeActionId(WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus)) {
        const parsedIn = issueTransitionInputSchema.safeParse(input ?? {});
        if (!parsedIn.success) {
          res.status(400).json({ error: "Invalid input", details: parsedIn.error.flatten() });
          return;
        }
        let issue = await issues.getById(parsedIn.data.issueId);
        if (!issue && /^[A-Z]+-\d+$/i.test(parsedIn.data.issueId.trim())) {
          issue = await issues.getByIdentifier(parsedIn.data.issueId.trim());
        }
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        if (issue.assigneeAgentId !== p.id) {
          res.status(403).json({ error: "Agent is not the issue assignee" });
          return;
        }

        if (
          issue.status === ISSUE_STATUS_IN_PROGRESS &&
          issue.assigneeAgentId === p.id
        ) {
          const runId = p.runId?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(issue.id, p.id, runId);
        }

        const updated = await issues.update(issue.id, { status: parsedIn.data.status });
        if (!updated) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "worker.tool_bridge",
          entityType: "issue",
          entityId: updated.id,
          details: {
            bridgeAction: WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus,
            fromStatus: issue.status,
            toStatus: parsedIn.data.status,
          },
        });
        res.status(200).json({
          ok: true,
          result: { issueId: updated.id, status: updated.status },
        });
        return;
      }

      if (actionId === normalizeActionId(WORKER_TOOL_BRIDGE_ACTIONS.issueGet)) {
        const parsedIn = issueGetInputSchema.safeParse(input ?? {});
        if (!parsedIn.success) {
          res.status(400).json({ error: "Invalid input", details: parsedIn.error.flatten() });
          return;
        }
        let issue = await issues.getById(parsedIn.data.issueId);
        if (!issue && /^[A-Z]+-\d+$/i.test(parsedIn.data.issueId.trim())) {
          issue = await issues.getByIdentifier(parsedIn.data.issueId.trim());
        }
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "worker.tool_bridge",
          entityType: "issue",
          entityId: issue.id,
          details: {
            bridgeAction: WORKER_TOOL_BRIDGE_ACTIONS.issueGet,
          },
        });
        res.status(200).json({
          ok: true,
          result: {
            issueId: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            status: issue.status,
            assigneeAgentId: issue.assigneeAgentId ?? null,
            projectId: issue.projectId ?? null,
          },
        });
        return;
      }

      res.status(501).json({ error: "Action not implemented" });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, details: err.details });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  return router;
}
