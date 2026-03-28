import { Router, type NextFunction, type Request, type Response } from "express";
import { ISSUE_STATUS_IN_PROGRESS } from "@hive/shared";
import { z } from "zod";
import { logActivity } from "../../services/index.js";
import { validate } from "../../middleware/validate.js";
import { assertWorkerInstance, getWorkerApiActorInfo } from "../authz.js";
import { runWorkerApiAgentHire } from "../worker-api-agent-hire.js";
import { assertWorkerAgentCanCreateAgents } from "../worker-api-issue-helpers.js";
import { buildWorkerApiSuccessResponse } from "../worker-api-payload.js";
import { listPluginToolCatalogForCompany } from "../../services/plugin-tools.js";
import { requireAgentInCompany, resolveIssueParam } from "./helpers.js";
import {
  issueAppendBodySchema,
  issueGetQuerySchema,
  issueTransitionBodySchema,
  pluginToolsQuerySchema,
  WORKER_API_ACTIONS,
  workerAgentHireSchema,
  workerCostReportSchema,
} from "./schemas.js";
import type { WorkerApiRoutesContext } from "./worker-api-routes-context.js";

export function registerWorkerApiMiscRoutes(router: Router, ctx: WorkerApiRoutesContext) {
  const { db, strictSecretsMode, costs, issues } = ctx;
  router.post(
    "/agent-hires",
    validate(workerAgentHireSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const body = req.body as z.infer<typeof workerAgentHireSchema>;
        await requireAgentInCompany(db, body.agentId, companyId);
        await assertWorkerAgentCanCreateAgents(db, companyId, body.agentId);

        const runId = req.header("x-hive-run-id")?.trim() ?? null;
        const { agent, approval } = await runWorkerApiAgentHire(db, {
          strictSecretsMode,
          companyId,
          runId,
          body,
        });

        res.status(201).json(buildWorkerApiSuccessResponse(req, { agent, approval }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/cost-report",
    validate(workerCostReportSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const body = req.body as z.infer<typeof workerCostReportSchema>;
        await requireAgentInCompany(db, body.agentId, companyId);

        const { occurredAt, ...rest } = body;
        const event = await costs.createEvent(companyId, {
          ...rest,
          occurredAt: new Date(occurredAt),
        });

        const actor = getWorkerApiActorInfo(req, body.agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.costReport,
          entityType: "cost_event",
          entityId: event.id,
          details: { workerApi: true },
        });

        res.status(201).json(buildWorkerApiSuccessResponse(req, { costEventId: event.id }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/issues/:issueId/comments",
    validate(issueAppendBodySchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const issueIdParam = req.params.issueId as string;
        const { agentId, body: commentBody } = req.body as z.infer<typeof issueAppendBodySchema>;
        await requireAgentInCompany(db, agentId, companyId);

        const issue = await resolveIssueParam(issues, issueIdParam);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }

        if (issue.status === ISSUE_STATUS_IN_PROGRESS && issue.assigneeAgentId === agentId) {
          const runId = req.header("x-hive-run-id")?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(issue.id, agentId, runId);
        }

        const comment = await issues.addComment(issue.id, commentBody, { agentId });
        const actor = getWorkerApiActorInfo(req, agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.issueAppendComment,
          entityType: "issue_comment",
          entityId: comment.id,
          details: { workerApi: true, issueId: issue.id },
        });
        res.status(200).json(buildWorkerApiSuccessResponse(req, { commentId: comment.id, issueId: issue.id }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/issues/:issueId/transition",
    validate(issueTransitionBodySchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const issueIdParam = req.params.issueId as string;
        const { agentId, status: nextStatus } = req.body as z.infer<typeof issueTransitionBodySchema>;
        await requireAgentInCompany(db, agentId, companyId);

        const issue = await resolveIssueParam(issues, issueIdParam);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        if (issue.assigneeAgentId !== agentId) {
          res.status(403).json({ error: "Agent is not the issue assignee" });
          return;
        }

        if (issue.status === ISSUE_STATUS_IN_PROGRESS && issue.assigneeAgentId === agentId) {
          const runId = req.header("x-hive-run-id")?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(issue.id, agentId, runId);
        }

        const updated = await issues.update(issue.id, { status: nextStatus });
        if (!updated) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        const actor = getWorkerApiActorInfo(req, agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.issueTransitionStatus,
          entityType: "issue",
          entityId: updated.id,
          details: {
            workerApi: true,
            fromStatus: issue.status,
            toStatus: nextStatus,
          },
        });
        res.status(200).json(
          buildWorkerApiSuccessResponse(req, { issueId: updated.id, status: updated.status }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/plugin-tools", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId } = assertWorkerInstance(req);
      const parsedQ = pluginToolsQuerySchema.safeParse(req.query);
      if (!parsedQ.success) {
        res.status(400).json({ error: "Invalid query", details: parsedQ.error.flatten() });
        return;
      }
      const { agentId } = parsedQ.data;
      await requireAgentInCompany(db, agentId, companyId);
      const tools = await listPluginToolCatalogForCompany(db, companyId);
      res.status(200).json(buildWorkerApiSuccessResponse(req, { tools }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:issueId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId } = assertWorkerInstance(req);
      const issueIdParam = req.params.issueId as string;
      const parsedQ = issueGetQuerySchema.safeParse(req.query);
      if (!parsedQ.success) {
        res.status(400).json({ error: "Invalid query", details: parsedQ.error.flatten() });
        return;
      }
      const { agentId } = parsedQ.data;
      await requireAgentInCompany(db, agentId, companyId);

      const issue = await resolveIssueParam(issues, issueIdParam);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      if (issue.companyId !== companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const actor = getWorkerApiActorInfo(req, agentId);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: WORKER_API_ACTIONS.issueGet,
        entityType: "issue",
        entityId: issue.id,
        details: { workerApi: true },
      });
      const result = {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId ?? null,
        projectId: issue.projectId ?? null,
      };
      res.status(200).json(buildWorkerApiSuccessResponse(req, result));
    } catch (err) {
      next(err);
    }
  });
}
