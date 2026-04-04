import type { FastifyInstance } from "fastify";
import { checkoutIssueSchema } from "@hive/shared";
import { assertCompanyPermission, getActorInfo } from "../authz.js";
import { logActivity } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { shouldWakeAssigneeOnCheckout } from "../issues-checkout-wakeup.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueCheckoutRoutesF(fastify: FastifyInstance, ctx: IssueRoutesContext): void {
  const { db, svc, heartbeat } = ctx;

  fastify.post<{ Params: { id: string } }>("/api/issues/:id/checkout", async (req, reply) => {
    const { id } = req.params;
    const issue = await svc.getById(id);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyPermission(db, req, issue.companyId, "issues:write");
    const parsed = checkoutIssueSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as { agentId: string; expectedStatuses?: string[] };
    const p = req.principal ?? null;
    if (p?.type === "agent" && p.id !== body.agentId) return reply.status(403).send({ error: "Agent can only checkout as itself" });
    const checkoutRunId = p?.type === "agent" ? (p.runId?.trim() || null) : null;
    if (p?.type === "agent" && !checkoutRunId) throw Object.assign(new Error("Agent run id required"), { statusCode: 401 });
    if (checkoutRunId) {
      const ensuredRun = await heartbeat.ensureExternalRunForCheckout(issue.companyId, body.agentId, checkoutRunId, id);
      if (!ensuredRun) return reply.status(400).send({ error: "Invalid run id", details: "Run id must be a valid UUID" });
    }
    const updated = await svc.checkout(id, body.agentId, body.expectedStatuses ?? [], checkoutRunId);
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.checked_out", entityType: "issue", entityId: issue.id, details: { agentId: body.agentId } });
    const actorTypeForWake = p?.type === "agent" ? "agent" : "board";
    if (shouldWakeAssigneeOnCheckout({ actorType: actorTypeForWake, actorAgentId: p?.type === "agent" ? p.id ?? null : null, checkoutAgentId: body.agentId, checkoutRunId })) {
      void heartbeat.wakeup(body.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_checked_out", payload: { issueId: issue.id, mutation: "checkout" }, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId, contextSnapshot: { issueId: issue.id, source: "issue.checkout" } })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }
    return reply.send(updated);
  });

  fastify.post<{ Params: { id: string } }>("/api/issues/:id/release", async (req, reply) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    await ctx.assertAgentRunCheckoutOwnershipF(req, existing);
    const p = req.principal ?? null;
    const actorRunId = p?.type === "agent" ? (p.runId?.trim() || null) : null;
    if (p?.type === "agent" && !actorRunId) throw Object.assign(new Error("Agent run id required"), { statusCode: 401 });
    const released = await svc.release(id, p?.type === "agent" ? p.id : undefined, actorRunId);
    if (!released) return reply.status(404).send({ error: "Issue not found" });
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: released.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "issue.released", entityType: "issue", entityId: released.id });
    return reply.send(released);
  });
}
