import { Router } from "express";
import type { Db } from "@hive/db";
import { webhookDeliveries } from "@hive/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { listWebhookDeliveriesQuerySchema, webhookDeliveryRetrySchema } from "@hive/shared";
import { validate } from "../middleware/validate.js";
import { deliverWorkAvailable, issueService, logActivity, WORKABLE_STATUSES_FOR_WEBHOOK } from "../services/index.js";
import { assertCompanyRead, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

export function webhookDeliveryRoutes(db: Db) {
  const router = Router();
  const issueSvc = issueService(db);

  router.get("/companies/:companyId/webhook-deliveries", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);

    const parsed = listWebhookDeliveriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const { limit, since: sinceStr, agentId, issueId, status } = parsed.data;
    const since = sinceStr ? new Date(sinceStr) : null;

    const conditions = [eq(webhookDeliveries.companyId, companyId)];
    if (since && !Number.isNaN(since.getTime())) {
      conditions.push(gte(webhookDeliveries.createdAt, since));
    }
    if (agentId) conditions.push(eq(webhookDeliveries.agentId, agentId));
    if (issueId) conditions.push(eq(webhookDeliveries.issueId, issueId));
    if (status) conditions.push(eq(webhookDeliveries.status, status));

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);

    const deliveries = rows.map((r) => ({
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
    }));

    res.json({ deliveries });
  });

  router.post(
    "/companies/:companyId/webhook-deliveries/retry",
    validate(webhookDeliveryRetrySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);

      const { issueId, agentId } = req.body as { issueId: string; agentId: string };

      const issue = await issueSvc.getById(issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      if (issue.companyId !== companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (issue.assigneeAgentId !== agentId) {
        throw unprocessable("Issue is not assigned to this agent");
      }
      if (!(WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)) {
        throw unprocessable(
          `Issue status must be one of ${WORKABLE_STATUSES_FOR_WEBHOOK.join(", ")} for webhook retry`,
        );
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

      res.status(202).json({ accepted: true });
    },
  );

  return router;
}
