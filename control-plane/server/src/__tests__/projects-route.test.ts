import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestFastify, actorBoard, actorAgent } from "./helpers/route-app.js";
import { projectsPlugin } from "../routes/projects.js";

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
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorBoard([company1]),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/projects` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([projectPayload]);
      expect(mockProjectService.list).toHaveBeenCalledWith(company1);
      await app.close();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorAgent(company2),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/projects` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      expect(res.json().error).toContain("another company");
      expect(mockProjectService.list).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 403 when board user has no access to company", async () => {
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorBoard([company2]),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/projects` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      expect(mockProjectService.list).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("GET /api/projects/:id", () => {
    it("returns 200 with project when found and actor has access", async () => {
      mockProjectService.getById.mockResolvedValue(projectPayload);
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorBoard([company1]),
      });
      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(projectPayload);
      expect(mockProjectService.getById).toHaveBeenCalledWith(projectId);
      await app.close();
    });

    it("returns 404 when project not found", async () => {
      mockProjectService.getById.mockResolvedValue(null);
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorBoard([company1]),
      });
      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Project not found" });
      await app.close();
    });

    it("returns 403 when project belongs to company actor cannot access", async () => {
      mockProjectService.getById.mockResolvedValue(projectPayload);
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorBoard([company2]),
      });
      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      await app.close();
    });
  });

  describe("POST /api/companies/:companyId/projects", () => {
    it("returns 201 with created project on success", async () => {
      mockProjectService.create.mockResolvedValue(projectPayload);
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorBoard([company1]),
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${company1}/projects`,
        payload: { name: "New Project", status: "backlog" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(projectPayload);
      expect(mockProjectService.create).toHaveBeenCalledWith(
        company1,
        expect.objectContaining({ name: "New Project", status: "backlog" }),
      );
      expect(mockLogActivity).toHaveBeenCalled();
      await app.close();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = await createRouteTestFastify({
        plugin: (f) => projectsPlugin(f, { db }),
        principal: actorAgent(company2),
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${company1}/projects`,
        payload: { name: "New Project", status: "backlog" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockProjectService.create).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
