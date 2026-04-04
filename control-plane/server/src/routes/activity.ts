import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { listActivityQuerySchema } from "@hive/shared";
import { activityService } from "../services/activity.js";
import { assertCompanyPermission, assertCompanyRead } from "./authz.js";
import { issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.string(), z.unknown()).optional().nullable(),
});

export async function activityPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = activityService(db);
  const issueSvc = issueService(db);

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) return issueSvc.getByIdentifier(rawId);
    return issueSvc.getById(rawId);
  }

  fastify.get<{ Params: { companyId: string }; Querystring: Record<string, unknown> }>(
    "/api/companies/:companyId/activity",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      const parsed = listActivityQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
      let agentId = parsed.data.agentId;
      const p = req.principal;
      if (p?.type === "agent") agentId = p.id ?? undefined;
      return reply.send(await svc.list({ companyId, agentId, entityType: parsed.data.entityType, entityId: parsed.data.entityId }));
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/activity",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "activity:write");
      const parsed = createActivitySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const event = await svc.create({
        companyId,
        ...parsed.data,
        details: parsed.data.details ? sanitizeRecord(parsed.data.details) : null,
      });
      return reply.status(201).send(event);
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/issues/:id/activity", async (req, reply) => {
    const issue = await resolveIssueByRef(req.params.id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    return reply.send(await svc.forIssue(issue.id));
  });

  fastify.get<{ Params: { id: string } }>("/api/issues/:id/runs", async (req, reply) => {
    const issue = await resolveIssueByRef(req.params.id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    return reply.send(await svc.runsForIssue(issue.companyId, issue.id));
  });

  fastify.get<{ Params: { runId: string } }>("/api/heartbeat-runs/:runId/issues", async (req, reply) => {
    return reply.send(await svc.issuesForRun(req.params.runId));
  });
}
