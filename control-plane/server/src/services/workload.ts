import { and, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  companies,
  heartbeatRuns,
  issues,
} from "@hive/db";
import type {
  WorkloadAgentMetrics,
  WorkloadCapacityMetrics,
  WorkloadQueueMetrics,
  WorkloadRecommendation,
  WorkloadResponse,
  WorkloadThresholds,
} from "@hive/shared";
import {
  ISSUE_STATUSES_PENDING,
  ISSUE_STATUSES_BACKLOG_TODO,
  ISSUE_STATUSES_CLOSED,
  ISSUE_STATUS_DONE,
} from "@hive/shared";
import { notFound } from "../errors.js";
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const FINISHED_RUN_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const lower = raw.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}

function buildThresholds(): WorkloadThresholds {
  return {
    queue_depth_normal: numEnv("HIVE_WORKLOAD_QUEUE_DEPTH_NORMAL", 20),
    queue_depth_throttle: numEnv("HIVE_WORKLOAD_QUEUE_DEPTH_THROTTLE", 50),
    queue_depth_shed: numEnv("HIVE_WORKLOAD_QUEUE_DEPTH_SHED", 100),
    busy_ratio_throttle: numEnv("HIVE_WORKLOAD_BUSY_RATIO_THROTTLE", 0.8),
    busy_ratio_shed: numEnv("HIVE_WORKLOAD_BUSY_RATIO_SHED", 0.95),
    error_rate_throttle: numEnv("HIVE_WORKLOAD_ERROR_RATE_THROTTLE", 0.1),
    error_rate_shed: numEnv("HIVE_WORKLOAD_ERROR_RATE_SHED", 0.25),
    recent_window_seconds: Math.max(
      1,
      Math.floor(numEnv("HIVE_WORKLOAD_RECENT_WINDOW_SECONDS", 300)),
    ),
    error_rate_enabled: boolEnv("HIVE_WORKLOAD_ERROR_RATE_ENABLED", true),
  };
}

const THRESHOLDS = buildThresholds();

type RecommendationLevel = "normal" | "throttle" | "shed" | "pause";

function escalate(
  current: RecommendationLevel,
  proposed: RecommendationLevel,
): RecommendationLevel {
  const order: RecommendationLevel[] = ["normal", "throttle", "shed", "pause"];
  return order.indexOf(proposed) > order.indexOf(current) ? proposed : current;
}

function computeRecommendation(
  capacity: WorkloadCapacityMetrics,
  queue: WorkloadQueueMetrics,
  agentsMetrics: WorkloadAgentMetrics,
): WorkloadRecommendation {
  const reasons: string[] = [];
  let level: RecommendationLevel = "normal";

  if (THRESHOLDS.error_rate_enabled) {
    if (capacity.error_rate >= THRESHOLDS.error_rate_shed) {
      level = escalate(level, "shed");
      reasons.push(
        `High error rate: ${(capacity.error_rate * 100).toFixed(1)}%`,
      );
    } else if (capacity.error_rate >= THRESHOLDS.error_rate_throttle) {
      level = escalate(level, "throttle");
      reasons.push(
        `Elevated error rate: ${(capacity.error_rate * 100).toFixed(1)}%`,
      );
    }
  }

  if (queue.total_pending >= THRESHOLDS.queue_depth_shed) {
    level = escalate(level, "shed");
    reasons.push(`Queue depth critical: ${queue.total_pending} pending tasks`);
  } else if (queue.total_pending >= THRESHOLDS.queue_depth_throttle) {
    level = escalate(level, "throttle");
    reasons.push(`Queue depth high: ${queue.total_pending} pending tasks`);
  }

  if (agentsMetrics.busy_ratio >= THRESHOLDS.busy_ratio_shed) {
    level = escalate(level, "shed");
    reasons.push(
      `Agent saturation critical: ${(agentsMetrics.busy_ratio * 100).toFixed(0)}% busy`,
    );
  } else if (agentsMetrics.busy_ratio >= THRESHOLDS.busy_ratio_throttle) {
    level = escalate(level, "throttle");
    reasons.push(
      `Agent saturation high: ${(agentsMetrics.busy_ratio * 100).toFixed(0)}% busy`,
    );
  }

  if (agentsMetrics.online === 0) {
    level = "pause";
    reasons.push(
      agentsMetrics.total > 0 ? "No agents online" : "No agents registered",
    );
  }

  const delayMap: Record<RecommendationLevel, number> = {
    normal: 0,
    throttle: 2000,
    shed: 10000,
    pause: 30000,
  };

  const actionDescriptions: Record<RecommendationLevel, string> = {
    normal: "System healthy — submit work freely",
    throttle:
      "System under load — reduce submission rate and defer non-critical work",
    shed: "System overloaded — submit only critical/high-priority work, defer everything else",
    pause: "No agents available — hold all submissions until agents are online again",
  };

  return {
    action: level,
    reason: actionDescriptions[level],
    details: reasons.length > 0 ? reasons : ["All metrics within normal bounds"],
    submit_ok: level === "normal" || level === "throttle",
    suggested_delay_ms: delayMap[level],
  };
}

async function buildQueueMetrics(
  db: Db,
  companyId: string,
  nowSeconds: number,
): Promise<WorkloadQueueMetrics> {
  const byStatusRows = await db
    .select({ status: issues.status, count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, [...ISSUE_STATUSES_PENDING]),
      ),
    )
    .groupBy(issues.status);

  const byPriorityRows = await db
    .select({ priority: issues.priority, count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, [...ISSUE_STATUSES_PENDING]),
      ),
    )
    .groupBy(issues.priority);

  const byStatus: Record<string, number> = {};
  for (const s of ISSUE_STATUSES_PENDING) {
    byStatus[s] = 0;
  }
  let totalPending = 0;
  for (const row of byStatusRows) {
    const count = Number(row.count);
    byStatus[row.status] = count;
    totalPending += count;
  }

  const byPriority: Record<string, number> = {};
  for (const p of PRIORITIES) {
    byPriority[p] = 0;
  }
  for (const row of byPriorityRows) {
    byPriority[row.priority] = Number(row.count);
  }

  const oldestRow = await db
    .select({
      oldest: sql<number | null>`min(extract(epoch from ${issues.createdAt}))::double precision`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, [...ISSUE_STATUSES_BACKLOG_TODO]),
      ),
    )
    .then((rows) => rows[0]);

  const oldestEpoch = oldestRow?.oldest ?? null;
  const oldest_pending_age_seconds =
    oldestEpoch !== null ? Math.floor(nowSeconds - oldestEpoch) : null;

  const hourAgo = new Date((nowSeconds - 3600) * 1000);
  const completionsLastHour = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, ISSUE_STATUS_DONE),
        gte(issues.updatedAt, hourAgo),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));

  const estimated_wait_seconds =
    completionsLastHour > 0
      ? Math.round((totalPending / completionsLastHour) * 3600)
      : null;

  return {
    total_pending: totalPending,
    by_status: byStatus,
    by_priority: byPriority,
    oldest_pending_age_seconds,
    estimated_wait_seconds,
    estimated_wait_confidence:
      estimated_wait_seconds === null ? "unknown" : "calculated",
  };
}

async function buildAgentMetrics(
  db: Db,
  companyId: string,
): Promise<WorkloadAgentMetrics> {
  const rows = await db
    .select({ status: agents.status, count: sql<number>`count(*)::int` })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .groupBy(agents.status);

  const statusMap: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const count = Number(row.count);
    statusMap[row.status] = count;
    total += count;
  }

  const idle = statusMap["idle"] ?? 0;
  const busy = statusMap["running"] ?? 0;
  const online = idle + busy;

  const busy_ratio =
    online > 0 ? Math.round((busy / online) * 100) / 100 : 0;

  return {
    total,
    online,
    busy,
    idle,
    busy_ratio,
  };
}

async function buildCapacityMetrics(
  db: Db,
  companyId: string,
  nowSeconds: number,
): Promise<WorkloadCapacityMetrics> {
  const windowStart = new Date(
    (nowSeconds - THRESHOLDS.recent_window_seconds) * 1000,
  );

  const [activeIssuesResult] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        notInArray(issues.status, [...ISSUE_STATUSES_CLOSED]),
      ),
    );

  const active_runsResult = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));

  const finishedInWindow = await db
    .select({
      status: heartbeatRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.finishedAt, windowStart),
        inArray(heartbeatRuns.status, [...FINISHED_RUN_STATUSES]),
      ),
    )
    .groupBy(heartbeatRuns.status);

  let runs_last_window = 0;
  let errors_last_window = 0;
  for (const row of finishedInWindow) {
    const count = Number(row.count);
    runs_last_window += count;
    if (row.status === "failed" || row.status === "timed_out") {
      errors_last_window += count;
    }
  }

  const error_rate =
    runs_last_window > 0
      ? Math.max(
          0,
          Math.min(1, Math.round((errors_last_window / runs_last_window) * 10000) / 10000),
        )
      : 0;

  return {
    active_issues: Number(activeIssuesResult?.count ?? 0),
    active_runs: active_runsResult,
    runs_last_window,
    errors_last_window,
    error_rate,
  };
}

const WORKLOAD_ACTION_RANK: Record<RecommendationLevel, number> = {
  normal: 0,
  throttle: 1,
  shed: 2,
  pause: 3,
};

export function workloadService(db: Db) {
  const getWorkload = async (companyId: string): Promise<WorkloadResponse> => {
    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (!company) throw notFound("Company not found");

    const nowSeconds = Math.floor(Date.now() / 1000);

    const [queue, agentsMetrics, capacity] = await Promise.all([
      buildQueueMetrics(db, companyId, nowSeconds),
      buildAgentMetrics(db, companyId),
      buildCapacityMetrics(db, companyId, nowSeconds),
    ]);

    const recommendation = computeRecommendation(
      capacity,
      queue,
      agentsMetrics,
    );

    return {
      timestamp: nowSeconds,
      companyId,
      capacity,
      queue,
      agents: agentsMetrics,
      recommendation,
      thresholds: THRESHOLDS,
    };
  };

  return {
    /**
     * Instance-operator view: rank companies by workload severity (highest first).
     * Caps DB load by scanning at most `scanLimit` companies.
     */
    listTopCompaniesByWorkload: async (
      scanLimit: number,
      topN: number,
    ): Promise<
      Array<{
        companyId: string;
        companyName: string;
        action: WorkloadResponse["recommendation"]["action"];
        reason: string;
        details: string[];
      }>
    > => {
      const rows = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .orderBy(companies.name)
        .limit(Math.max(1, Math.min(scanLimit, 100)));

      const scored = await Promise.all(
        rows.map(async (row) => {
          const w = await getWorkload(row.id);
          return {
            companyId: row.id,
            companyName: row.name,
            action: w.recommendation.action,
            reason: w.recommendation.reason,
            details: w.recommendation.details,
            rank: WORKLOAD_ACTION_RANK[w.recommendation.action as RecommendationLevel],
          };
        }),
      );

      scored.sort((a, b) => b.rank - a.rank);
      return scored.slice(0, Math.max(1, Math.min(topN, 25))).map(({ rank: _r, ...rest }) => rest);
    },

    getWorkload,
  };
}
