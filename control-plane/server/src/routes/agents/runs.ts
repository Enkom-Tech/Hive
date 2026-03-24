import { Router } from "express";
import { z } from "zod";
import type { Db } from "@hive/db";
import { agents as agentsTable, heartbeatRuns } from "@hive/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import { ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK, ISSUE_STATUS_IN_PROGRESS } from "@hive/shared";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { assertBoard, assertCompanyAccess } from "../authz.js";
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
  assertBoard: typeof assertBoard;
  assertCompanyAccess: typeof assertCompanyAccess;
  logActivity: (input: LogActivityInput) => Promise<void>;
};

export function registerAgentRunsRoutes(router: Router, deps: AgentRunsDeps): void {
  const {
    db,
    heartbeatService: heartbeat,
    agentService: svc,
    issueService: issueSvc,
    assertBoard: assertBoardFn,
    assertCompanyAccess: assertCompanyAccessFn,
    logActivity: logActivityFn,
  } = deps;

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccessFn(req, companyId);
    const parsed = listHeartbeatRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const runs = await heartbeat.list(companyId, parsed.data.agentId, parsed.data.limit);
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccessFn(req, companyId);

    const parsed = liveRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const minCount = parsed.data.minCount;

    const columns = {
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRuns = await db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    if (minCount > 0 && liveRuns.length < minCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(minCount - liveRuns.length);

      res.json([...liveRuns, ...recentRuns]);
      return;
    }

    res.json(liveRuns);
  });

  router.patch("/heartbeat-runs/:runId", async (req, res) => {
    const p = getCurrentPrincipal(req);
    if (p?.type !== "agent" || !p.id) {
      res.status(403).json({ error: "Agent authentication required" });
      return;
    }
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    if (run.agentId !== p.id || run.companyId !== p.company_id) {
      res.status(403).json({ error: "Cannot touch another agent's run" });
      return;
    }
    await heartbeat.touchRun(runId);
    res.status(204).send();
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccessFn(req, run.companyId);
    res.json(redactCurrentUserValue(run));
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoardFn(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivityFn({
        companyId: run.companyId,
        actorType: "user",
        actorId: getCurrentPrincipal(req)?.id ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccessFn(req, run.companyId);

    const parsed = heartbeatRunEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const events = await heartbeat.listEvents(runId, parsed.data.afterSeq, parsed.data.limit);
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccessFn(req, run.companyId);

    const parsed = heartbeatRunLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const result = await heartbeat.readLog(runId, {
      offset: parsed.data.offset,
      limitBytes: parsed.data.limitBytes,
    });

    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier
      ? await issueSvc.getByIdentifier(rawId)
      : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccessFn(req, issue.companyId);

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(liveRuns);
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier
      ? await issueSvc.getByIdentifier(rawId)
      : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccessFn(req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;
    if (run && run.status !== "queued" && run.status !== "running") {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === ISSUE_STATUS_IN_PROGRESS) {
      const candidateRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const candidateContext = asRecord(candidateRun?.contextSnapshot);
      const candidateIssueId = asNonEmptyString(candidateContext?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    res.json({
      ...redactCurrentUserValue(run),
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
    });
  });

  router.get("/agents/:id/work-items", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccessFn(req, agent.companyId);
    const pRun = getCurrentPrincipal(req);
    if (pRun?.type === "agent" && pRun.id !== id) {
      res.status(403).json({ error: "Agent can only request own work-items" });
      return;
    }
    const tasks = await issueSvc.list(agent.companyId, {
      assigneeAgentId: id,
      status: ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK.join(","),
    });
    res.json({ tasks });
  });
}
