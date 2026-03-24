import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestApp, actorBoard, actorAgent } from "./helpers/route-app.js";
import { projectRoutes } from "../routes/projects.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWorkspace: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  logActivity: (...args: unknown[]) => mockLogActivity(...args),
}));

const company1 = "company-1";
const company2 = "company-2";
const projectId = "project-uuid-1";
const projectPayload = { id: projectId, companyId: company1, name: "Test Project", status: "active" };

describe("projects route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /api/companies/:companyId/projects", () => {
    it("returns 200 with list when board has company access", async () => {
      mockProjectService.list.mockResolvedValue([projectPayload]);
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/companies/${company1}/projects`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([projectPayload]);
      expect(mockProjectService.list).toHaveBeenCalledWith(company1);
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorAgent(company2),
      });
      const res = await request(app).get(`/api/companies/${company1}/projects`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(res.body.error).toContain("another company");
      expect(mockProjectService.list).not.toHaveBeenCalled();
    });

    it("returns 403 when board user has no access to company", async () => {
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/companies/${company1}/projects`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockProjectService.list).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/projects/:id", () => {
    it("returns 200 with project when found and actor has access", async () => {
      mockProjectService.getById.mockResolvedValue(projectPayload);
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/projects/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(projectPayload);
      expect(mockProjectService.getById).toHaveBeenCalledWith(projectId);
    });

    it("returns 404 when project not found", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/projects/${projectId}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Project not found" });
    });

    it("returns 403 when project belongs to company actor cannot access", async () => {
      mockProjectService.getById.mockResolvedValue(projectPayload);
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/projects/${projectId}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("POST /api/companies/:companyId/projects", () => {
    it("returns 201 with created project on success", async () => {
      mockProjectService.create.mockResolvedValue(projectPayload);
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/projects`)
        .send({ name: "New Project", status: "backlog" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(projectPayload);
      expect(mockProjectService.create).toHaveBeenCalledWith(company1, expect.objectContaining({ name: "New Project", status: "backlog" }));
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = createRouteTestApp({
        router: projectRoutes(db),
        principal: actorAgent(company2),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/projects`)
        .send({ name: "New Project", status: "backlog" });
      expect(res.status).toBe(403);
      expect(mockProjectService.create).not.toHaveBeenCalled();
    });
  });
});
