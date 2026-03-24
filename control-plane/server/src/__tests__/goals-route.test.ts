import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestApp, actorBoard, actorAgent } from "./helpers/route-app.js";
import { goalRoutes } from "../routes/goals.js";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: (...args: unknown[]) => mockLogActivity(...args),
}));

const company1 = "company-1";
const company2 = "company-2";
const goalId = "goal-uuid-1";
const goalPayload = { id: goalId, companyId: company1, title: "Test Goal", level: "company", status: "active" };

describe("goals route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /api/companies/:companyId/goals", () => {
    it("returns 200 with list when board has company access", async () => {
      mockGoalService.list.mockResolvedValue([goalPayload]);
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/companies/${company1}/goals`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([goalPayload]);
      expect(mockGoalService.list).toHaveBeenCalledWith(company1);
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorAgent(company2),
      });
      const res = await request(app).get(`/api/companies/${company1}/goals`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockGoalService.list).not.toHaveBeenCalled();
    });

    it("returns 403 when board user has no access to company", async () => {
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/companies/${company1}/goals`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockGoalService.list).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/goals/:id", () => {
    it("returns 200 with goal when found and actor has access", async () => {
      mockGoalService.getById.mockResolvedValue(goalPayload);
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/goals/${goalId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(goalPayload);
      expect(mockGoalService.getById).toHaveBeenCalledWith(goalId);
    });

    it("returns 404 when goal not found", async () => {
      mockGoalService.getById.mockResolvedValue(null);
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/goals/${goalId}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Goal not found" });
    });

    it("returns 403 when goal belongs to company actor cannot access", async () => {
      mockGoalService.getById.mockResolvedValue(goalPayload);
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/goals/${goalId}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("POST /api/companies/:companyId/goals", () => {
    it("returns 201 with created goal on success", async () => {
      mockGoalService.create.mockResolvedValue(goalPayload);
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/goals`)
        .send({ title: "New Goal" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(goalPayload);
      expect(mockGoalService.create).toHaveBeenCalledWith(company1, expect.objectContaining({ title: "New Goal" }));
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = createRouteTestApp({
        router: goalRoutes(db),
        principal: actorAgent(company2),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/goals`)
        .send({ title: "New Goal" });
      expect(res.status).toBe(403);
      expect(mockGoalService.create).not.toHaveBeenCalled();
    });
  });
});
