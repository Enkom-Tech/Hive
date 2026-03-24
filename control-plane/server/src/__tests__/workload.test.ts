import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { workloadRoutes } from "../routes/workload.js";

const getWorkloadMock = vi.fn();

vi.mock("../services/workload.js", () => ({
  workloadService: () => ({ getWorkload: getWorkloadMock }),
}));

function createApp(actor: {
  type: "board" | "agent";
  userId?: string;
  agentId?: string;
  companyId?: string;
  source?: string;
}) {
  const app = express();
  app.use((req, _res, next) => {
    req.principal =
      actor.type === "board"
        ? (actor.source === "session"
          ? { type: "user", id: actor.userId ?? "board", company_ids: [], roles: [] }
          : { type: "system", id: actor.userId ?? "board", roles: [] })
        : { type: "agent", id: actor.agentId ?? "agent-1", company_id: actor.companyId ?? "company-A", roles: [] };
    next();
  });
  app.use(workloadRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const companyA = "550e8400-e29b-41d4-a716-446655440000";

const normalWorkload = {
  timestamp: 1709900000,
  companyId: companyA,
  capacity: {
    active_issues: 5,
    active_runs: 1,
    runs_last_window: 10,
    errors_last_window: 0,
    error_rate: 0,
  },
  queue: {
    total_pending: 5,
    by_status: { backlog: 2, todo: 2, in_progress: 1, in_review: 0, blocked: 0 },
    by_priority: { critical: 0, high: 1, medium: 4, low: 0 },
    oldest_pending_age_seconds: 100,
    estimated_wait_seconds: 3600,
    estimated_wait_confidence: "calculated" as const,
  },
  agents: {
    total: 2,
    online: 2,
    busy: 1,
    idle: 1,
    busy_ratio: 0.5,
  },
  recommendation: {
    action: "normal" as const,
    reason: "System healthy — submit work freely",
    details: ["All metrics within normal bounds"],
    submit_ok: true,
    suggested_delay_ms: 0,
  },
  thresholds: {
    queue_depth_normal: 20,
    queue_depth_throttle: 50,
    queue_depth_shed: 100,
    busy_ratio_throttle: 0.8,
    busy_ratio_shed: 0.95,
    error_rate_throttle: 0.1,
    error_rate_shed: 0.25,
    recent_window_seconds: 300,
    error_rate_enabled: true,
  },
};

const pauseWorkload = {
  ...normalWorkload,
  agents: {
    total: 2,
    online: 0,
    busy: 0,
    idle: 0,
    busy_ratio: 0,
  },
  recommendation: {
    action: "pause" as const,
    reason: "No agents available — hold all submissions until agents are online again",
    details: ["No agents online"],
    submit_ok: false,
    suggested_delay_ms: 30000,
  },
};

describe("GET /companies/:companyId/workload", () => {
  beforeEach(() => {
    getWorkloadMock.mockReset();
  });

  it("returns 200 with normal recommendation under light load", async () => {
    getWorkloadMock.mockResolvedValueOnce(normalWorkload);
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/companies/${companyA}/workload`);
    expect(res.status).toBe(200);
    expect(res.body.recommendation.action).toBe("normal");
    expect(res.body.recommendation.submit_ok).toBe(true);
    expect(res.body.companyId).toBe(companyA);
    expect(res.body.capacity).toBeDefined();
    expect(res.body.queue).toBeDefined();
    expect(res.body.agents).toBeDefined();
    expect(res.body.thresholds).toBeDefined();
  });

  it("returns 200 with pause recommendation when no agents online", async () => {
    getWorkloadMock.mockResolvedValueOnce(pauseWorkload);
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/companies/${companyA}/workload`);
    expect(res.status).toBe(200);
    expect(res.body.recommendation.action).toBe("pause");
    expect(res.body.recommendation.submit_ok).toBe(false);
  });

  it("returns 404 when company does not exist", async () => {
    getWorkloadMock.mockRejectedValueOnce(notFound("Company not found"));
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/companies/${companyA}/workload`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Company not found");
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-A",
    });
    const otherCompanyId = "660e8400-e29b-41d4-a716-446655440001";
    const res = await request(app).get(
      `/companies/${otherCompanyId}/workload`,
    );
    expect(res.status).toBe(403);
    expect(getWorkloadMock).not.toHaveBeenCalled();
  });

  it("returns 200 when agent key calls with own company id", async () => {
    getWorkloadMock.mockResolvedValueOnce(normalWorkload);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: companyA,
    });
    const res = await request(app).get(`/companies/${companyA}/workload`);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyA);
    expect(getWorkloadMock).toHaveBeenCalledWith(companyA);
  });
});
