import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestApp, actorBoard, actorAgent } from "./helpers/route-app.js";
import { dashboardRoutes } from "../routes/dashboard.js";

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

const company1 = "company-1";
const company2 = "company-2";
const summaryPayload = {
  companyId: company1,
  agents: { active: 1, running: 0, paused: 0, error: 0 },
  tasks: { open: 2, inProgress: 0, blocked: 0, qualityReview: 0, done: 0 },
  costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
  pendingApprovals: 0,
};

describe("dashboard route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/companies/:companyId/dashboard", () => {
    it("returns 200 with summary when actor has company access", async () => {
      mockDashboardService.summary.mockResolvedValue(summaryPayload);
      const app = createRouteTestApp({
        router: dashboardRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/companies/${company1}/dashboard`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(summaryPayload);
      expect(mockDashboardService.summary).toHaveBeenCalledWith(company1);
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = createRouteTestApp({
        router: dashboardRoutes(db),
        principal: actorAgent(company2),
      });
      const res = await request(app).get(`/api/companies/${company1}/dashboard`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockDashboardService.summary).not.toHaveBeenCalled();
    });

    it("returns 403 when board user has no access to company", async () => {
      const app = createRouteTestApp({
        router: dashboardRoutes(db),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/companies/${company1}/dashboard`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockDashboardService.summary).not.toHaveBeenCalled();
    });
  });
});
