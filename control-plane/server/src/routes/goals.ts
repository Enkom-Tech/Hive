import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { createGoalSchema, updateGoalSchema } from "@hive/shared";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "./authz.js";

export async function goalsPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = goalService(db);

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/goals",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await svc.list(companyId));
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) => {
    const goal = await svc.getById(req.params.id);
    if (!goal) return reply.status(404).send({ error: "Goal not found" });
    await assertCompanyRead(db, req, goal.companyId);
    return reply.send(goal);
  });

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/goals",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "goals:write");
      const parsed = createGoalSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const goal = await svc.create(companyId, parsed.data);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "goal.created",
        entityType: "goal",
        entityId: goal.id,
        details: { title: goal.title },
      });
      return reply.status(201).send(goal);
    },
  );

  fastify.patch<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Goal not found" });
    await assertCompanyPermission(db, req, existing.companyId, "goals:write");
    const parsed = updateGoalSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
    const goal = await svc.update(req.params.id, parsed.data);
    if (!goal) return reply.status(404).send({ error: "Goal not found" });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: parsed.data,
    });
    return reply.send(goal);
  });

  fastify.delete<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) return reply.status(404).send({ error: "Goal not found" });
    await assertCompanyPermission(db, req, existing.companyId, "goals:write");
    const goal = await svc.remove(req.params.id);
    if (!goal) return reply.status(404).send({ error: "Goal not found" });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });
    return reply.send(goal);
  });
}
