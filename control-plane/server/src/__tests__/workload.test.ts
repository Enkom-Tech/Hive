import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { notFound } from "../errors.js";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { workloadPlugin } from "../routes/workload.js";

const getWorkloadMock = vi.fn();

vi.mock("../services/workload.js", () => ({
  workloadService: () => ({ getWorkload: getWorkloadMock }),
}));

const db = {} as unknown as Db;

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

const boardPrincipal: Principal = { type: "system", id: "board", roles: [] };

describe("GET /api/companies/:companyId/workload", () => {
  beforeEach(() => {
    getWorkloadMock.mockReset();
  });

  it("returns 200 with normal recommendation under light load", async () => {
    getWorkloadMock.mockResolvedValueOnce(normalWorkload);
    const app = await createRouteTestFastify({
      plugin: (f) => workloadPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/workload` });
    expect(res.statusCode).toBe(200);
    expect(res.json().recommendation.action).toBe("normal");
    expect(res.json().recommendation.submit_ok).toBe(true);
    expect(res.json().companyId).toBe(companyA);
    expect(res.json().capacity).toBeDefined();
    expect(res.json().queue).toBeDefined();
    expect(res.json().agents).toBeDefined();
    expect(res.json().thresholds).toBeDefined();
    await app.close();
  });

  it("returns 200 with pause recommendation when no agents online", async () => {
    getWorkloadMock.mockResolvedValueOnce(pauseWorkload);
    const app = await createRouteTestFastify({
      plugin: (f) => workloadPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/workload` });
    expect(res.statusCode).toBe(200);
    expect(res.json().recommendation.action).toBe("pause");
    expect(res.json().recommendation.submit_ok).toBe(false);
    await app.close();
  });

  it("returns 404 when company does not exist", async () => {
    getWorkloadMock.mockRejectedValueOnce(notFound("Company not found"));
    const app = await createRouteTestFastify({
      plugin: (f) => workloadPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/workload` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Company not found");
    await app.close();
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const principal: Principal = {
      type: "agent",
      id: "agent-1",
      company_id: "company-A",
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => workloadPlugin(f, { db }),
      principal,
    });
    const otherCompanyId = "660e8400-e29b-41d4-a716-446655440001";
    const res = await app.inject({ method: "GET", url: `/api/companies/${otherCompanyId}/workload` });
    expect(res.statusCode).toBe(403);
    expect(getWorkloadMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 200 when agent key calls with own company id", async () => {
    getWorkloadMock.mockResolvedValueOnce(normalWorkload);
    const principal: Principal = {
      type: "agent",
      id: "agent-1",
      company_id: companyA,
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => workloadPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/workload` });
    expect(res.statusCode).toBe(200);
    expect(res.json().companyId).toBe(companyA);
    expect(getWorkloadMock).toHaveBeenCalledWith(companyA);
    await app.close();
  });
});
