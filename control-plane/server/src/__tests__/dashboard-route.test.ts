import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestFastify, actorBoard, actorAgent } from "./helpers/route-app.js";
import { dashboardPlugin } from "../routes/dashboard.js";

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
      const app = await createRouteTestFastify({
        plugin: (f) => dashboardPlugin(f, { db }),
        principal: actorBoard([company1]),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/dashboard` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(summaryPayload);
      expect(mockDashboardService.summary).toHaveBeenCalledWith(company1);
      await app.close();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = await createRouteTestFastify({
        plugin: (f) => dashboardPlugin(f, { db }),
        principal: actorAgent(company2),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/dashboard` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      expect(mockDashboardService.summary).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 403 when board user has no access to company", async () => {
      const app = await createRouteTestFastify({
        plugin: (f) => dashboardPlugin(f, { db }),
        principal: actorBoard([company2]),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/dashboard` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      expect(mockDashboardService.summary).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
