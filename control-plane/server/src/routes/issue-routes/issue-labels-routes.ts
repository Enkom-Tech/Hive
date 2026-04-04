import type { FastifyInstance } from "fastify";
import { createIssueLabelSchema } from "@hive/shared";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { logActivity } from "../../services/index.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueLabelsRoutesF(fastify: FastifyInstance, ctx: IssueRoutesContext): void {
  const { db, svc } = ctx;

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/labels", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    return reply.send(await svc.listLabels(companyId));
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/labels", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "issues:write");
    const parsed = createIssueLabelSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const label = await svc.createLabel(companyId, parsed.data);
    const actor = getActorInfo(req);
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "label.created", entityType: "label", entityId: label.id, details: { name: label.name, color: label.color } });
    return reply.status(201).send(label);
  });

  fastify.delete<{ Params: { labelId: string } }>("/api/labels/:labelId", async (req, reply) => {
    const { labelId } = req.params;
    const existing = await svc.getLabelById(labelId);
    if (!existing) return reply.status(404).send({ error: "Label not found" });
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    const removed = await svc.deleteLabel(labelId);
    if (!removed) return reply.status(404).send({ error: "Label not found" });
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: removed.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "label.deleted", entityType: "label", entityId: removed.id, details: { name: removed.name, color: removed.color } });
    return reply.send(removed);
  });
}
