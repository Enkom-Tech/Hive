import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { FastifyInstance } from "fastify";
import { accessPlugin } from "../routes/access.js";
import { actorBoard, createRouteTestFastify } from "./helpers/route-app.js";

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

const accessOpts = {
  deploymentMode: "authenticated" as const,
  deploymentExposure: "private" as const,
  bindHost: "localhost",
  allowedHostnames: ["localhost"],
  joinAllowedAdapterTypes: undefined,
};

describe("access route", () => {
  const db = {} as unknown as Db;
  const accessDouble = () => accessService(db);
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    accessDouble().canUser.mockResolvedValue(true);
    accessDouble().hasPermission.mockResolvedValue(true);
  });

  afterEach(async () => {
    await app?.close();
  });

  describe("GET /api/companies/:companyId/members", () => {
    it("returns 200 with members when board has permission (local_implicit)", async () => {
      accessDouble().listMembers.mockResolvedValue([{ id: "m1", principalType: "user", role: "owner" }]);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "local_implicit" }),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/members` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ id: "m1", principalType: "user", role: "owner" }]);
      expect(accessDouble().listMembers).toHaveBeenCalledWith(company1);
    });

    it("returns 200 when session board user has canUser permission", async () => {
      accessDouble().canUser.mockResolvedValue(true);
      accessDouble().listMembers.mockResolvedValue([]);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "session" }),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/members` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(accessDouble().canUser).toHaveBeenCalledWith(company1, userId, "users:manage_permissions");
    });

    it("returns 403 when session board user lacks permission", async () => {
      accessDouble().canUser.mockResolvedValue(false);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "session" }),
      });
      const res = await app.inject({ method: "GET", url: `/api/companies/${company1}/members` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "Permission denied" });
      expect(accessDouble().listMembers).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/admin/users/:userId/company-access", () => {
    it("returns 200 with company-access when instance admin (local_implicit)", async () => {
      accessDouble().listUserCompanyAccess.mockResolvedValue([{ companyId: company1, role: "owner" }]);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "local_implicit" }),
      });
      const res = await app.inject({ method: "GET", url: `/api/admin/users/${userId}/company-access` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ companyId: company1, role: "owner" }]);
      expect(accessDouble().listUserCompanyAccess).toHaveBeenCalledWith(userId);
    });

    it("returns 403 when session board user is not instance admin", async () => {
      accessDouble().isInstanceAdmin.mockResolvedValue(false);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "session" }),
      });
      const res = await app.inject({ method: "GET", url: `/api/admin/users/${userId}/company-access` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "Instance admin required" });
      expect(accessDouble().listUserCompanyAccess).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/companies/:companyId/members/:memberId/permissions", () => {
    it("returns 404 when member not found", async () => {
      accessDouble().canUser.mockResolvedValue(true);
      accessDouble().setMemberPermissions.mockResolvedValue(null);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "session" }),
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/companies/${company1}/members/member-404/permissions`,
        payload: { grants: [] },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Member not found" });
    });

    it("returns 200 with updated member when found", async () => {
      const updated = { id: "m1", principalType: "user", role: "owner", grants: [] };
      accessDouble().canUser.mockResolvedValue(true);
      accessDouble().setMemberPermissions.mockResolvedValue(updated);
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db, ...accessOpts }),
        principal: actorBoard([company1], { source: "session" }),
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/companies/${company1}/members/m1/permissions`,
        payload: { grants: [] },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(updated);
    });
  });
});
