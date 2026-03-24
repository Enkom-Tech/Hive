import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
import { actorBoard } from "./helpers/route-app.js";

const mockAccessService = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  setMemberPermissions: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({}),
  secretService: () => ({}),
}));

const company1 = "company-1";
const userId = "user-1";

function createAccessApp(db: Db, principal: ReturnType<typeof actorBoard>) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    (res as express.Response & { locals: object }).locals = {};
    next();
  });
  app.use((req, _res, next) => {
    (req as express.Request & { principal: unknown }).principal = principal;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "localhost",
      allowedHostnames: ["localhost"],
      joinAllowedAdapterTypes: undefined,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("access route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/companies/:companyId/members", () => {
    it("returns 200 with members when board has permission (local_implicit)", async () => {
      mockAccessService.listMembers.mockResolvedValue([{ id: "m1", principalType: "user", role: "owner" }]);
      const app = createAccessApp(db, actorBoard([company1], { source: "local_implicit" }));
      const res = await request(app).get(`/api/companies/${company1}/members`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "m1", principalType: "user", role: "owner" }]);
      expect(mockAccessService.listMembers).toHaveBeenCalledWith(company1);
    });

    it("returns 200 when session board user has canUser permission", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.listMembers.mockResolvedValue([]);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app).get(`/api/companies/${company1}/members`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAccessService.canUser).toHaveBeenCalledWith(company1, userId, "users:manage_permissions");
    });

    it("returns 403 when session board user lacks permission", async () => {
      mockAccessService.canUser.mockResolvedValue(false);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app).get(`/api/companies/${company1}/members`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
      expect(mockAccessService.listMembers).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/admin/users/:userId/company-access", () => {
    it("returns 200 with company-access when instance admin (local_implicit)", async () => {
      mockAccessService.listUserCompanyAccess.mockResolvedValue([{ companyId: company1, role: "owner" }]);
      const app = createAccessApp(db, actorBoard([company1], { source: "local_implicit" }));
      const res = await request(app).get(`/api/admin/users/${userId}/company-access`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ companyId: company1, role: "owner" }]);
      expect(mockAccessService.listUserCompanyAccess).toHaveBeenCalledWith(userId);
    });

    it("returns 403 when session board user is not instance admin", async () => {
      mockAccessService.isInstanceAdmin.mockResolvedValue(false);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app).get(`/api/admin/users/${userId}/company-access`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Instance admin required" });
      expect(mockAccessService.listUserCompanyAccess).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/companies/:companyId/members/:memberId/permissions", () => {
    it("returns 404 when member not found", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.setMemberPermissions.mockResolvedValue(null);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app)
        .patch(`/api/companies/${company1}/members/member-404/permissions`)
        .send({ grants: [] });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Member not found" });
    });

    it("returns 200 with updated member when found", async () => {
      const updated = { id: "m1", principalType: "user", role: "owner", grants: [] };
      mockAccessService.canUser.mockResolvedValue(true);
      mockAccessService.setMemberPermissions.mockResolvedValue(updated);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app)
        .patch(`/api/companies/${company1}/members/m1/permissions`)
        .send({ grants: [] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
    });
  });
});
