import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
import { actorBoard } from "./helpers/route-app.js";

vi.mock("../services/index.js", async () => {
  const { accessService } = await import("../services/access.js");
  return {
    accessService,
    agentService: () => ({}),
    secretService: () => ({}),
  };
});

import { accessService } from "../services/access.js";

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
  const accessDouble = () => accessService(db);

  beforeEach(() => {
    vi.clearAllMocks();
    accessDouble().canUser.mockResolvedValue(true);
    accessDouble().hasPermission.mockResolvedValue(true);
  });

  describe("GET /api/companies/:companyId/members", () => {
    it("returns 200 with members when board has permission (local_implicit)", async () => {
      accessDouble().listMembers.mockResolvedValue([{ id: "m1", principalType: "user", role: "owner" }]);
      const app = createAccessApp(db, actorBoard([company1], { source: "local_implicit" }));
      const res = await request(app).get(`/api/companies/${company1}/members`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "m1", principalType: "user", role: "owner" }]);
      expect(accessDouble().listMembers).toHaveBeenCalledWith(company1);
    });

    it("returns 200 when session board user has canUser permission", async () => {
      accessDouble().canUser.mockResolvedValue(true);
      accessDouble().listMembers.mockResolvedValue([]);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app).get(`/api/companies/${company1}/members`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(accessDouble().canUser).toHaveBeenCalledWith(company1, userId, "users:manage_permissions");
    });

    it("returns 403 when session board user lacks permission", async () => {
      accessDouble().canUser.mockResolvedValue(false);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app).get(`/api/companies/${company1}/members`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Permission denied" });
      expect(accessDouble().listMembers).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/admin/users/:userId/company-access", () => {
    it("returns 200 with company-access when instance admin (local_implicit)", async () => {
      accessDouble().listUserCompanyAccess.mockResolvedValue([{ companyId: company1, role: "owner" }]);
      const app = createAccessApp(db, actorBoard([company1], { source: "local_implicit" }));
      const res = await request(app).get(`/api/admin/users/${userId}/company-access`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ companyId: company1, role: "owner" }]);
      expect(accessDouble().listUserCompanyAccess).toHaveBeenCalledWith(userId);
    });

    it("returns 403 when session board user is not instance admin", async () => {
      accessDouble().isInstanceAdmin.mockResolvedValue(false);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app).get(`/api/admin/users/${userId}/company-access`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Instance admin required" });
      expect(accessDouble().listUserCompanyAccess).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/companies/:companyId/members/:memberId/permissions", () => {
    it("returns 404 when member not found", async () => {
      accessDouble().canUser.mockResolvedValue(true);
      accessDouble().setMemberPermissions.mockResolvedValue(null);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app)
        .patch(`/api/companies/${company1}/members/member-404/permissions`)
        .send({ grants: [] });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Member not found" });
    });

    it("returns 200 with updated member when found", async () => {
      const updated = { id: "m1", principalType: "user", role: "owner", grants: [] };
      accessDouble().canUser.mockResolvedValue(true);
      accessDouble().setMemberPermissions.mockResolvedValue(updated);
      const app = createAccessApp(db, actorBoard([company1], { source: "session" }));
      const res = await request(app)
        .patch(`/api/companies/${company1}/members/m1/permissions`)
        .send({ grants: [] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
    });
  });
});
