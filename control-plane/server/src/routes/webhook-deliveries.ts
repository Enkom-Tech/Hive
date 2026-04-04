import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { webhookDeliveries } from "@hive/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { listWebhookDeliveriesQuerySchema, webhookDeliveryRetrySchema } from "@hive/shared";
import { deliverWorkAvailable, issueService, logActivity, WORKABLE_STATUSES_FOR_WEBHOOK } from "../services/index.js";
import { assertCompanyRead, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

export async function webhookDeliveriesPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const issueSvc = issueService(db);

  fastify.get<{ Params: { companyId: string }; Querystring: Record<string, unknown> }>(
    "/api/companies/:companyId/webhook-deliveries",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      const parsed = listWebhookDeliveriesQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
      const { limit, since: sinceStr, agentId, issueId, status } = parsed.data;
      const since = sinceStr ? new Date(sinceStr) : null;

      const conditions = [eq(webhookDeliveries.companyId, companyId)];
      if (since && !Number.isNaN(since.getTime())) conditions.push(gte(webhookDeliveries.createdAt, since));
      if (agentId) conditions.push(eq(webhookDeliveries.agentId, agentId));
      if (issueId) conditions.push(eq(webhookDeliveries.issueId, issueId));
      if (status) conditions.push(eq(webhookDeliveries.status, status));

      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(and(...conditions))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit);

      return reply.send({
        deliveries: rows.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          agentId: r.agentId,
          issueId: r.issueId,
          eventType: r.eventType,
          status: r.status,
          httpStatusCode: r.httpStatusCode,
          responseBodyExcerpt: r.responseBodyExcerpt,
          durationMs: r.durationMs,
          attemptNumber: r.attemptNumber,
          createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
        })),
      });
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/webhook-deliveries/retry",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      const parsed = webhookDeliveryRetrySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const { issueId, agentId } = parsed.data;

      const issue = await issueSvc.getById(issueId);
      if (!issue) return reply.status(404).send({ error: "Issue not found" });
      if (issue.companyId !== companyId) return reply.status(403).send({ error: "Forbidden" });
      if (issue.assigneeAgentId !== agentId) throw unprocessable("Issue is not assigned to this agent");
      if (!(WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)) {
        throw unprocessable(`Issue status must be one of ${WORKABLE_STATUSES_FOR_WEBHOOK.join(", ")} for webhook retry`);
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? undefined,
        action: "webhook_delivery.retry",
        entityType: "webhook_delivery",
        entityId: issueId,
        details: { agentId, issueId },
      });

      void deliverWorkAvailable(agentId, companyId, issueId, db).catch((err) =>
        logger.warn({ err, issueId, agentId }, "webhook retry delivery failed"),
      );

      return reply.status(202).send({ accepted: true });
    },
  );
}
