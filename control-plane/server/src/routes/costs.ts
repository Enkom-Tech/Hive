import { Router } from "express";
import type { Db } from "@hive/db";
import { costsDateRangeQuerySchema, createCostEventSchema, updateBudgetSchema } from "@hive/shared";
import { validate } from "../middleware/validate.js";
import { costService, companyService, agentService, logActivity } from "../services/index.js";
import { getCurrentPrincipal } from "../auth/principal.js";
import { assertCompanyAccess, assertCompanyPermission, getActorInfo } from "./authz.js";

export function costRoutes(db: Db) {
  const router = Router();
  const costs = costService(db);
  const companies = companyService(db);
  const agents = agentService(db);

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const p = getCurrentPrincipal(req);
    if (p?.type === "agent") {
      if (!req.body.agentId || p.id !== req.body.agentId) {
        res.status(403).json({ error: "Agent can only report its own costs" });
        return;
      }
    }

    const { occurredAt, ...rest } = req.body;
    const event = await costs.createEvent(companyId, {
      ...rest,
      occurredAt: new Date(occurredAt),
    });

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

    res.status(201).json(event);
  });

  const MAX_SERIES_RANGE_DAYS = 366;

  function buildRangeFromParsed(parsed: { from?: string; to?: string }) {
    const from = parsed.from ? new Date(parsed.from) : undefined;
    const to = parsed.to ? new Date(parsed.to) : undefined;
    return from || to ? { from, to } : undefined;
  }

  function rangeDays(range: { from?: Date; to?: Date } | undefined): number | null {
    if (!range?.from || !range?.to) return null;
    const ms = range.to.getTime() - range.from.getTime();
    return Math.ceil(ms / (24 * 60 * 60 * 1000));
  }

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "costs:read");
    const parsed = costsDateRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const range = buildRangeFromParsed(parsed.data);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "costs:read");
    const parsed = costsDateRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const range = buildRangeFromParsed(parsed.data);
    const rows = await costs.byAgent(companyId, range);
    const pByAgent = getCurrentPrincipal(req);
    if (pByAgent?.type === "agent" && pByAgent.id) {
      const selfRow = rows.filter((r) => r.agentId === pByAgent.id);
      res.json(selfRow);
      return;
    }
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "costs:read");
    const parsed = costsDateRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const range = buildRangeFromParsed(parsed.data);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/series", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "costs:read");
    const parsed = costsDateRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const range = buildRangeFromParsed(parsed.data);
    const days = rangeDays(range);
    if (days !== null && days > MAX_SERIES_RANGE_DAYS) {
      res.status(400).json({
        error: `Date range exceeds maximum of ${MAX_SERIES_RANGE_DAYS} days`,
      });
      return;
    }
    const bucket = parsed.data.bucket ?? "day";
    const rows = await costs.series(companyId, range, bucket);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "costs:read");
    const parsed = costsDateRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const range = buildRangeFromParsed(parsed.data);
    const rows = await costs.byModel(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "costs:manage");
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const pAgentBudget = getCurrentPrincipal(req);
    if (pAgentBudget?.type === "agent") {
      if (pAgentBudget.id !== agentId) {
        res.status(403).json({ error: "Agent can only change its own budget" });
        return;
      }
    } else {
      await assertCompanyPermission(db, req, agent.companyId, "costs:manage");
    }

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

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

    res.json(updated);
  });

  return router;
}
