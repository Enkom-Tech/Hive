import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@hive/db";
import { agents as agentsTable, companies } from "@hive/db";
import { and, eq, inArray } from "drizzle-orm";
import { deriveAgentUrlKey, type InstanceSchedulerHeartbeatAgent } from "@hive/shared";
import {
  actorCanReadConfigurationsForCompany,
  assertCanReadConfigurations,
  assertCanUpdateAgent,
  type AgentRoutesCommonDeps,
} from "./common.js";
import { assertBoard, assertCompanyRead, getActorInfo } from "../authz.js";
import { redactEventPayload } from "../../redaction.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import { isAgentWorkerConnected } from "../../workers/worker-link.js";

type HeartbeatService = ReturnType<typeof import("../../services/heartbeat/index.js").heartbeatService>;
type ActivityService = ReturnType<typeof import("../../services/activity.js").activityService>;
type CostService = ReturnType<typeof import("../../services/costs.js").costService>;

const agentAttributionQuerySchema = z.object({
  activityLimit: z
    .string()
    .optional()
    .transform((s) => Math.min(500, Math.max(1, parseInt(s ?? "50", 10) || 50))),
  runsLimit: z
    .string()
    .optional()
    .transform((s) => Math.min(100, Math.max(1, parseInt(s ?? "20", 10) || 20))),
  from: z.string().optional(),
  to: z.string().optional(),
  privileged: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
  const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
  return {
    enabled: parseBooleanLike(heartbeat.enabled) ?? true,
    intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
  };
}

function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const record = snapshot as Record<string, unknown>;
  return {
    ...record,
    adapterConfig: redactEventPayload(
      typeof record.adapterConfig === "object" && record.adapterConfig !== null
        ? (record.adapterConfig as Record<string, unknown>)
        : {},
    ),
    runtimeConfig: redactEventPayload(
      typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
        ? (record.runtimeConfig as Record<string, unknown>)
        : {},
    ),
    metadata:
      typeof record.metadata === "object" && record.metadata !== null
        ? redactEventPayload(record.metadata as Record<string, unknown>)
        : record.metadata ?? null,
  };
}

function redactConfigRevision(
  revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
) {
  return {
    ...revision,
    beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
    afterConfig: redactRevisionSnapshot(revision.afterConfig),
  };
}

function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
  const reports = Array.isArray(node.reports)
    ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
    : [];
  return {
    id: String(node.id),
    name: String(node.name),
    role: String(node.role),
    status: String(node.status),
    reports,
  };
}

export type AgentListGetDeps = AgentRoutesCommonDeps & {
  heartbeatService: HeartbeatService;
  activityService: ActivityService;
  costService: CostService;
  getActorInfo: typeof getActorInfo;
  logActivity: (input: LogActivityInput) => Promise<void>;
};

function redactForRestrictedAgentView(
  agent: Awaited<ReturnType<AgentListGetDeps["agentService"]["getById"]>>,
) {
  if (!agent) return null;
  return { ...agent, adapterConfig: {}, runtimeConfig: {} };
}

function redactAgentConfiguration(
  agent: Awaited<ReturnType<AgentListGetDeps["agentService"]["getById"]>>,
) {
  if (!agent) return null;
  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    reportsTo: agent.reportsTo,
    adapterType: agent.adapterType,
    adapterConfig: redactEventPayload(agent.adapterConfig),
    runtimeConfig: redactEventPayload(agent.runtimeConfig),
    permissions: agent.permissions,
    updatedAt: agent.updatedAt,
  };
}

export function registerAgentListGetRoutesF(fastify: FastifyInstance, deps: AgentListGetDeps): void {
  const {
    db,
    agentService: svc,
    access,
    heartbeatService: heartbeat,
    activityService: activitySvc,
    costService: costs,
    getActorInfo: getActorInfoFn,
    logActivity: logActivityFn,
  } = deps;
  const commonDeps = { db, access, agentService: svc };

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/agents", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const result = await svc.list(companyId);
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId, commonDeps);
    const p = req.principal ?? null;
    if (canReadConfigs || p?.type === "user" || p?.type === "system") return reply.send(result);
    return reply.send(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/drones/overview", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    return reply.send(await svc.listDroneBoardAgentOverview(companyId));
  });

  fastify.get("/api/instance/scheduler-heartbeats", async (req, reply) => {
    assertBoard(req);
    const pSched = req.principal ?? null;
    const accessConditions = [];
    if (pSched?.type !== "system" && !pSched?.roles?.includes("instance_admin")) {
      const allowedCompanyIds = pSched?.company_ids ?? [];
      if (allowedCompanyIds.length === 0) return reply.send([]);
      accessConditions.push(inArray(agentsTable.companyId, allowedCompanyIds));
    }

    const rows = await db.select({
      id: agentsTable.id, companyId: agentsTable.companyId, agentName: agentsTable.name,
      role: agentsTable.role, title: agentsTable.title, status: agentsTable.status,
      adapterType: agentsTable.adapterType, runtimeConfig: agentsTable.runtimeConfig,
      lastHeartbeatAt: agentsTable.lastHeartbeatAt, companyName: companies.name,
      companyIssuePrefix: companies.issuePrefix,
    }).from(agentsTable).innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .where(accessConditions.length > 0 ? and(...accessConditions) : undefined)
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows.map((row) => {
      const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
      const statusEligible = row.status !== "paused" && row.status !== "terminated" && row.status !== "pending_approval";
      return {
        id: row.id, companyId: row.companyId, companyName: row.companyName,
        companyIssuePrefix: row.companyIssuePrefix, agentName: row.agentName,
        agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
        role: row.role as InstanceSchedulerHeartbeatAgent["role"],
        title: row.title, status: row.status as InstanceSchedulerHeartbeatAgent["status"],
        adapterType: row.adapterType, intervalSec: policy.intervalSec,
        heartbeatEnabled: policy.enabled,
        schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
        lastHeartbeatAt: row.lastHeartbeatAt,
      };
    }).filter((item) => item.intervalSec > 0 && item.status !== "paused" && item.status !== "terminated" && item.status !== "pending_approval")
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) return left.schedulerActive ? -1 : 1;
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    return reply.send(items);
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/org", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const tree = await svc.orgForCompany(companyId);
    return reply.send(tree.map((node) => toLeanOrgNode(node as Record<string, unknown>)));
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/agent-configurations", async (req, reply) => {
    const { companyId } = req.params;
    await assertCanReadConfigurations(req, companyId, commonDeps);
    const rows = await svc.list(companyId);
    return reply.send(rows.map((row) => redactAgentConfiguration(row)));
  });

  fastify.get("/api/agents/me", async (req, reply) => {
    const p = req.principal ?? null;
    if (p?.type !== "agent" || !p.id) return reply.status(401).send({ error: "Agent authentication required" });
    const agent = await svc.getById(p.id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const chainOfCommand = await svc.getChainOfCommand(agent.id);
    return reply.send({ ...agent, chainOfCommand });
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/attribution", async (req, reply) => {
    const { id } = req.params;
    const parsed = agentAttributionQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    const { activityLimit, runsLimit, from: fromStr, to: toStr, privileged } = parsed.data;
    const from = fromStr ? new Date(fromStr) : undefined;
    const to = toStr ? new Date(toStr) : undefined;
    const range = from || to ? { from, to } : undefined;

    let agentId = id;
    const p = req.principal ?? null;
    if (id === "me") {
      if (p?.type !== "agent" || !p.id) return reply.status(400).send({ error: "Use /agents/me/attribution with agent authentication" });
      agentId = p.id;
    }

    const agent = await svc.getById(agentId);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);

    if (p?.type === "agent" && p.id !== agentId) return reply.status(403).send({ error: "Agent can only view own attribution" });

    const [activity, byAgentRows, runs] = await Promise.all([
      activitySvc.list({ companyId: agent.companyId, agentId, limit: activityLimit }),
      costs.byAgent(agent.companyId, range),
      heartbeat.list(agent.companyId, agentId, runsLimit),
    ]);

    const agentRow = byAgentRows.find((r) => r.agentId != null && r.agentId === agentId);
    const spendCents = agentRow?.costCents ?? 0;
    const budgetCents = agent.budgetMonthlyCents ?? 0;
    const utilizationPercent = budgetCents > 0 ? Number(((spendCents / budgetCents) * 100).toFixed(2)) : 0;
    const cost = { spendCents, budgetCents, utilizationPercent, ...(range?.from && range?.to && { period: { from: range.from.toISOString(), to: range.to.toISOString() } }) };

    const payload: { agentId: string; companyId: string; cost: typeof cost; activity: typeof activity; runs: typeof runs; companySpendCents?: number; companyBudgetCents?: number } =
      { agentId, companyId: agent.companyId, cost, activity, runs };

    if ((p?.type === "user" || p?.type === "system") && privileged) {
      const summary = await costs.summary(agent.companyId, range);
      payload.companySpendCents = summary.spendCents;
      payload.companyBudgetCents = summary.budgetCents;
    }
    return reply.send(payload);
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    const p = req.principal ?? null;
    if (p?.type === "agent" && p.id !== id) {
      const canRead = await actorCanReadConfigurationsForCompany(req, agent.companyId, commonDeps);
      if (!canRead) {
        const chainOfCommand = await svc.getChainOfCommand(agent.id);
        return reply.send({ ...redactForRestrictedAgentView(agent), chainOfCommand });
      }
    }
    const chainOfCommand = await svc.getChainOfCommand(agent.id);
    return reply.send({ ...agent, chainOfCommand });
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/worker-connection", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    const p = req.principal ?? null;
    if (p?.type === "agent" && p.id !== id) {
      const canRead = await actorCanReadConfigurationsForCompany(req, agent.companyId, commonDeps);
      if (!canRead) return reply.status(403).send({ error: "Forbidden" });
    }
    return reply.send({ connected: isAgentWorkerConnected(id) });
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/configuration", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCanReadConfigurations(req, agent.companyId, commonDeps);
    return reply.send(redactAgentConfiguration(agent));
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/config-revisions", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCanReadConfigurations(req, agent.companyId, commonDeps);
    const revisions = await svc.listConfigRevisions(id);
    return reply.send(revisions.map((revision) => redactConfigRevision(revision)));
  });

  fastify.get<{ Params: { id: string; revisionId: string } }>("/api/agents/:id/config-revisions/:revisionId", async (req, reply) => {
    const { id, revisionId } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCanReadConfigurations(req, agent.companyId, commonDeps);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) return reply.status(404).send({ error: "Revision not found" });
    return reply.send(redactConfigRevision(revision));
  });

  fastify.post<{ Params: { id: string; revisionId: string } }>("/api/agents/:id/config-revisions/:revisionId/rollback", async (req, reply) => {
    const { id, revisionId } = req.params;
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCanUpdateAgent(req, existing, commonDeps);
    const actor = getActorInfoFn(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) return reply.status(404).send({ error: "Revision not found" });
    await logActivityFn({
      companyId: updated.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent", entityId: updated.id,
      details: { revisionId },
    });
    return reply.send(updated);
  });
}
