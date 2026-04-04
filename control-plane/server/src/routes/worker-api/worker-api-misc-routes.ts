import type { FastifyInstance } from "fastify";
import { ISSUE_STATUS_IN_PROGRESS } from "@hive/shared";
import { z } from "zod";
import { logActivity } from "../../services/index.js";
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

export function registerWorkerApiMiscRoutesFastify(
  fastify: FastifyInstance,
  ctx: WorkerApiRoutesContext,
) {
  const { db, strictSecretsMode, costs, issues } = ctx;

  fastify.post<{ Body: z.infer<typeof workerAgentHireSchema> }>(
    "/agent-hires",
    async (req, reply) => {
      const body = workerAgentHireSchema.parse(req.body);
      const { companyId } = assertWorkerInstance(req);
      await requireAgentInCompany(db, body.agentId, companyId);
      await assertWorkerAgentCanCreateAgents(db, companyId, body.agentId);

      const runIdRaw = req.headers["x-hive-run-id"];
      const runId = (Array.isArray(runIdRaw) ? runIdRaw[0] : runIdRaw)?.trim() ?? null;
      const { agent, approval } = await runWorkerApiAgentHire(db, {
        strictSecretsMode,
        companyId,
        runId,
        body,
      });
      return reply.status(201).send(buildWorkerApiSuccessResponse(req, { agent, approval }));
    },
  );

  fastify.post<{ Body: z.infer<typeof workerCostReportSchema> }>(
    "/cost-report",
    async (req, reply) => {
      const body = workerCostReportSchema.parse(req.body);
      const { companyId } = assertWorkerInstance(req);
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
      return reply.status(201).send(buildWorkerApiSuccessResponse(req, { costEventId: event.id }));
    },
  );

  fastify.post<{ Params: { issueId: string }; Body: z.infer<typeof issueAppendBodySchema> }>(
    "/issues/:issueId/comments",
    async (req, reply) => {
      const body = issueAppendBodySchema.parse(req.body);
      const { companyId } = assertWorkerInstance(req);
      const { agentId, body: commentBody } = body;
      await requireAgentInCompany(db, agentId, companyId);

      const issue = await resolveIssueParam(issues, req.params.issueId);
      if (!issue) return reply.status(404).send({ error: "Issue not found" });
      if (issue.companyId !== companyId) return reply.status(403).send({ error: "Forbidden" });

      if (issue.status === ISSUE_STATUS_IN_PROGRESS && issue.assigneeAgentId === agentId) {
        const runIdRaw = req.headers["x-hive-run-id"];
        const runId = (Array.isArray(runIdRaw) ? runIdRaw[0] : runIdRaw)?.trim();
        if (!runId) {
          return reply.status(401).send({ error: "Agent run id required for checked-out issue" });
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
      return reply.status(200).send(buildWorkerApiSuccessResponse(req, { commentId: comment.id, issueId: issue.id }));
    },
  );

  fastify.post<{ Params: { issueId: string }; Body: z.infer<typeof issueTransitionBodySchema> }>(
    "/issues/:issueId/transition",
    async (req, reply) => {
      const body = issueTransitionBodySchema.parse(req.body);
      const { companyId } = assertWorkerInstance(req);
      const { agentId, status: nextStatus } = body;
      await requireAgentInCompany(db, agentId, companyId);

      const issue = await resolveIssueParam(issues, req.params.issueId);
      if (!issue) return reply.status(404).send({ error: "Issue not found" });
      if (issue.companyId !== companyId) return reply.status(403).send({ error: "Forbidden" });
      if (issue.assigneeAgentId !== agentId) {
        return reply.status(403).send({ error: "Agent is not the issue assignee" });
      }

      if (issue.status === ISSUE_STATUS_IN_PROGRESS && issue.assigneeAgentId === agentId) {
        const runIdRaw = req.headers["x-hive-run-id"];
        const runId = (Array.isArray(runIdRaw) ? runIdRaw[0] : runIdRaw)?.trim();
        if (!runId) {
          return reply.status(401).send({ error: "Agent run id required for checked-out issue" });
        }
        await issues.assertCheckoutOwner(issue.id, agentId, runId);
      }

      const updated = await issues.update(issue.id, { status: nextStatus });
      if (!updated) return reply.status(404).send({ error: "Issue not found" });

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
        details: { workerApi: true, fromStatus: issue.status, toStatus: nextStatus },
      });
      return reply.status(200).send(
        buildWorkerApiSuccessResponse(req, { issueId: updated.id, status: updated.status }),
      );
    },
  );

  fastify.get<{ Querystring: z.infer<typeof pluginToolsQuerySchema> }>(
    "/plugin-tools",
    async (req, reply) => {
      const { companyId } = assertWorkerInstance(req);
      const parsedQ = pluginToolsQuerySchema.safeParse(req.query);
      if (!parsedQ.success) {
        return reply.status(400).send({ error: "Invalid query", details: parsedQ.error.flatten() });
      }
      const { agentId } = parsedQ.data;
      await requireAgentInCompany(db, agentId, companyId);
      const tools = await listPluginToolCatalogForCompany(db, companyId);
      return reply.status(200).send(buildWorkerApiSuccessResponse(req, { tools }));
    },
  );

  fastify.get<{ Params: { issueId: string }; Querystring: z.infer<typeof issueGetQuerySchema> }>(
    "/issues/:issueId",
    async (req, reply) => {
      const { companyId } = assertWorkerInstance(req);
      const parsedQ = issueGetQuerySchema.safeParse(req.query);
      if (!parsedQ.success) {
        return reply.status(400).send({ error: "Invalid query", details: parsedQ.error.flatten() });
      }
      const { agentId } = parsedQ.data;
      await requireAgentInCompany(db, agentId, companyId);

      const issue = await resolveIssueParam(issues, req.params.issueId);
      if (!issue) return reply.status(404).send({ error: "Issue not found" });
      if (issue.companyId !== companyId) return reply.status(403).send({ error: "Forbidden" });

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
      return reply.status(200).send(buildWorkerApiSuccessResponse(req, result));
    },
  );
}
