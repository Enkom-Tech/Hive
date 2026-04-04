import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@hive/db";
import { agents as agentsTable, heartbeatRuns } from "@hive/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import { ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK, ISSUE_STATUS_IN_PROGRESS } from "@hive/shared";
import { assertCompanyPermission, assertCompanyRead } from "../authz.js";
import { redactCurrentUserValue } from "../../log-redaction.js";
import { redactEventPayload } from "../../redaction.js";
import type { LogActivityInput } from "../../services/activity-log.js";

const listHeartbeatRunsQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  limit: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? parseInt(s, 10) : 200;
      return Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : undefined;
    }),
});

const liveRunsQuerySchema = z.object({
  minCount: z
    .string()
    .optional()
    .transform((s) => Math.max(0, Math.min(20, parseInt(s ?? "0", 10) || 0))),
});

const heartbeatRunEventsQuerySchema = z.object({
  afterSeq: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? parseInt(s, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }),
  limit: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? parseInt(s, 10) : 200;
      return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 200;
    }),
});

const heartbeatRunLogQuerySchema = z.object({
  offset: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? parseInt(s, 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }),
  limitBytes: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? parseInt(s, 10) : 256000;
      return Number.isFinite(n) ? Math.max(1, Math.min(1024 * 1024, n)) : 256000;
    }),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type HeartbeatService = ReturnType<typeof import("../../services/heartbeat/index.js").heartbeatService>;
type AgentService = ReturnType<typeof import("../../services/agents.js").agentService>;
type IssueService = ReturnType<typeof import("../../services/issues.js").issueService>;

export type AgentRunsDeps = {
  db: Db;
  heartbeatService: HeartbeatService;
  agentService: AgentService;
  issueService: IssueService;
  logActivity: (input: LogActivityInput) => Promise<void>;
};

export function registerAgentRunsRoutesF(fastify: FastifyInstance, deps: AgentRunsDeps): void {
  const { db, heartbeatService: heartbeat, agentService: svc, issueService: issueSvc, logActivity: logActivityFn } = deps;

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/heartbeat-runs", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const parsed = listHeartbeatRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    return reply.send(await heartbeat.list(companyId, parsed.data.agentId, parsed.data.limit));
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/live-runs", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const parsed = liveRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    const minCount = parsed.data.minCount;

    const columns = {
      id: heartbeatRuns.id, status: heartbeatRuns.status, invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt, agentId: heartbeatRuns.agentId, agentName: agentsTable.name,
      adapterType: agentsTable.adapterType, issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRuns = await db.select(columns).from(heartbeatRuns).innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    if (minCount > 0 && liveRuns.length < minCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db.select(columns).from(heartbeatRuns).innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          not(inArray(heartbeatRuns.status, ["queued", "running"])),
          ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
        )).orderBy(desc(heartbeatRuns.createdAt)).limit(minCount - liveRuns.length);
      return reply.send([...liveRuns, ...recentRuns]);
    }
    return reply.send(liveRuns);
  });

  fastify.patch<{ Params: { runId: string } }>("/api/heartbeat-runs/:runId", async (req, reply) => {
    const p = req.principal ?? null;
    if (p?.type !== "agent" || !p.id) return reply.status(403).send({ error: "Agent authentication required" });
    const { runId } = req.params;
    const run = await heartbeat.getRun(runId);
    if (!run) return reply.status(404).send({ error: "Heartbeat run not found" });
    if (run.agentId !== p.id || run.companyId !== p.company_id) return reply.status(403).send({ error: "Cannot touch another agent's run" });
    await heartbeat.touchRun(runId);
    return reply.status(204).send();
  });

  fastify.get<{ Params: { runId: string } }>("/api/heartbeat-runs/:runId", async (req, reply) => {
    const { runId } = req.params;
    const run = await heartbeat.getRun(runId);
    if (!run) return reply.status(404).send({ error: "Heartbeat run not found" });
    await assertCompanyRead(db, req, run.companyId);
    return reply.send(redactCurrentUserValue(run));
  });

  fastify.post<{ Params: { runId: string } }>("/api/heartbeat-runs/:runId/cancel", async (req, reply) => {
    const { runId } = req.params;
    const preRun = await heartbeat.getRun(runId);
    if (!preRun) return reply.status(404).send({ error: "Heartbeat run not found" });
    await assertCompanyPermission(db, req, preRun.companyId, "runs:board");
    const run = await heartbeat.cancelRun(runId);
    if (run) {
      const p = req.principal ?? null;
      await logActivityFn({
        companyId: run.companyId,
        actorType: "user", actorId: p?.id ?? "board",
        action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: run.id,
        details: { agentId: run.agentId },
      });
    }
    return reply.send(run);
  });

  fastify.get<{ Params: { runId: string } }>("/api/heartbeat-runs/:runId/events", async (req, reply) => {
    const { runId } = req.params;
    const run = await heartbeat.getRun(runId);
    if (!run) return reply.status(404).send({ error: "Heartbeat run not found" });
    await assertCompanyRead(db, req, run.companyId);
    const parsed = heartbeatRunEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    const events = await heartbeat.listEvents(runId, parsed.data.afterSeq, parsed.data.limit);
    return reply.send(events.map((event) => redactCurrentUserValue({ ...event, payload: redactEventPayload(event.payload) })));
  });

  fastify.get<{ Params: { runId: string } }>("/api/heartbeat-runs/:runId/log", async (req, reply) => {
    const { runId } = req.params;
    const run = await heartbeat.getRun(runId);
    if (!run) return reply.status(404).send({ error: "Heartbeat run not found" });
    await assertCompanyRead(db, req, run.companyId);
    const parsed = heartbeatRunLogQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    return reply.send(await heartbeat.readLog(runId, { offset: parsed.data.offset, limitBytes: parsed.data.limitBytes }));
  });

  fastify.get<{ Params: { issueId: string } }>("/api/issues/:issueId/live-runs", async (req, reply) => {
    const { issueId: rawId } = req.params;
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);
    const liveRuns = await db.select({
      id: heartbeatRuns.id, status: heartbeatRuns.status, invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt, agentId: heartbeatRuns.agentId, agentName: agentsTable.name, adapterType: agentsTable.adapterType,
    }).from(heartbeatRuns).innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(and(eq(heartbeatRuns.companyId, issue.companyId), inArray(heartbeatRuns.status, ["queued", "running"]), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`))
      .orderBy(desc(heartbeatRuns.createdAt));
    return reply.send(liveRuns);
  });

  fastify.get<{ Params: { issueId: string } }>("/api/issues/:issueId/active-run", async (req, reply) => {
    const { issueId: rawId } = req.params;
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });
    await assertCompanyRead(db, req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;
    if (run && run.status !== "queued" && run.status !== "running") run = null;

    if (!run && issue.assigneeAgentId && issue.status === ISSUE_STATUS_IN_PROGRESS) {
      const candidateRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const candidateContext = asRecord(candidateRun?.contextSnapshot);
      const candidateIssueId = asNonEmptyString(candidateContext?.issueId);
      if (candidateRun && candidateIssueId === issue.id) run = candidateRun;
    }
    if (!run) return reply.send(null);

    const agent = await svc.getById(run.agentId);
    if (!agent) return reply.send(null);
    return reply.send({ ...redactCurrentUserValue(run), agentId: agent.id, agentName: agent.name, adapterType: agent.adapterType });
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/work-items", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    const p = req.principal ?? null;
    if (p?.type === "agent" && p.id !== id) return reply.status(403).send({ error: "Agent can only request own work-items" });
    const tasks = await issueSvc.list(agent.companyId, { assigneeAgentId: id, status: ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK.join(",") });
    return reply.send({ tasks });
  });
}
