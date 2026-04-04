import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { costsDateRangeQuerySchema, createCostEventSchema, updateBudgetSchema } from "@hive/shared";
import { costService, companyService, agentService, logActivity } from "../services/index.js";
import { assertCompanyAccess, assertCompanyPermission, getActorInfo } from "./authz.js";

export async function costsPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const costs = costService(db);
  const companies = companyService(db);
  const agents = agentService(db);

  const MAX_SERIES_RANGE_DAYS = 366;

  function buildRangeFromParsed(parsed: { from?: string; to?: string }) {
    const from = parsed.from ? new Date(parsed.from) : undefined;
    const to = parsed.to ? new Date(parsed.to) : undefined;
    return from || to ? { from, to } : undefined;
  }

  function rangeDays(range: { from?: Date; to?: Date } | undefined): number | null {
    if (!range?.from || !range?.to) return null;
    return Math.ceil((range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000));
  }

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/cost-events",
    async (req, reply) => {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const parsed = createCostEventSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const p = req.principal;
      if (p?.type === "agent") {
        if (!parsed.data.agentId || p.id !== parsed.data.agentId) {
          return reply.status(403).send({ error: "Agent can only report its own costs" });
        }
      }
      const { occurredAt, ...rest } = parsed.data;
      const event = await costs.createEvent(companyId, { ...rest, occurredAt: new Date(occurredAt) });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "cost.reported",
        entityType: "cost_event",
        entityId: event.id,
        details: { costCents: event.costCents, model: event.model },
      });
      return reply.status(201).send(event);
    },
  );

  for (const endpoint of ["summary", "by-agent", "by-project", "by-model"] as const) {
    fastify.get<{ Params: { companyId: string }; Querystring: Record<string, unknown> }>(
      `/api/companies/:companyId/costs/${endpoint}`,
      async (req, reply) => {
        const { companyId } = req.params;
        await assertCompanyPermission(db, req, companyId, "costs:read");
        const parsed = costsDateRangeQuerySchema.safeParse(req.query);
        if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
        const range = buildRangeFromParsed(parsed.data);
        const p = req.principal;
        if (endpoint === "summary") return reply.send(await costs.summary(companyId, range));
        if (endpoint === "by-agent") {
          const rows = await costs.byAgent(companyId, range);
          if (p?.type === "agent" && p.id) return reply.send(rows.filter((r) => r.agentId === p.id));
          return reply.send(rows);
        }
        if (endpoint === "by-project") return reply.send(await costs.byProject(companyId, range));
        return reply.send(await costs.byModel(companyId, range));
      },
    );
  }

  fastify.get<{ Params: { companyId: string }; Querystring: Record<string, unknown> }>(
    "/api/companies/:companyId/costs/series",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "costs:read");
      const parsed = costsDateRangeQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
      const range = buildRangeFromParsed(parsed.data);
      const days = rangeDays(range);
      if (days !== null && days > MAX_SERIES_RANGE_DAYS) {
        return reply.status(400).send({ error: `Date range exceeds maximum of ${MAX_SERIES_RANGE_DAYS} days` });
      }
      return reply.send(await costs.series(companyId, range, parsed.data.bucket ?? "day"));
    },
  );

  fastify.patch<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/budgets",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "costs:manage");
      const parsed = updateBudgetSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const company = await companies.update(companyId, { budgetMonthlyCents: parsed.data.budgetMonthlyCents });
      if (!company) return reply.status(404).send({ error: "Company not found" });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.principal?.id ?? "board",
        action: "company.budget_updated",
        entityType: "company",
        entityId: companyId,
        details: { budgetMonthlyCents: parsed.data.budgetMonthlyCents },
      });
      return reply.send(company);
    },
  );

  fastify.patch<{ Params: { agentId: string } }>(
    "/api/agents/:agentId/budgets",
    async (req, reply) => {
      const { agentId } = req.params;
      const agent = await agents.getById(agentId);
      if (!agent) return reply.status(404).send({ error: "Agent not found" });
      const p = req.principal;
      if (p?.type === "agent") {
        if (p.id !== agentId) return reply.status(403).send({ error: "Agent can only change its own budget" });
      } else {
        await assertCompanyPermission(db, req, agent.companyId, "costs:manage");
      }
      const parsed = updateBudgetSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const updated = await agents.update(agentId, { budgetMonthlyCents: parsed.data.budgetMonthlyCents });
      if (!updated) return reply.status(404).send({ error: "Agent not found" });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: updated.id,
        details: { budgetMonthlyCents: updated.budgetMonthlyCents },
      });
      return reply.send(updated);
    },
  );
}
