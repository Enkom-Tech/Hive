import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestApp, actorBoard, actorAgent } from "./helpers/route-app.js";
import { secretRoutes } from "../routes/secrets.js";

const mockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn().mockReturnValue(["local_encrypted"]),
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const mockMigrationService = vi.hoisted(() => ({
  dryRun: vi.fn(),
  apply: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  secretService: () => mockSecretService,
  secretProviderMigrationService: () => mockMigrationService,
  logActivity: (...args: unknown[]) => mockLogActivity(...args),
}));

const company1 = "company-1";
const company2 = "company-2";
const secretId = "secret-uuid-1";
const secretPayload = { id: secretId, companyId: company1, name: "test-secret", provider: "local_encrypted" };

describe("secrets route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretService.listProviders.mockReturnValue(["local_encrypted"]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /api/companies/:companyId/secrets", () => {
    it("returns 200 with list when board has company access", async () => {
      mockSecretService.list.mockResolvedValue([secretPayload]);
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/companies/${company1}/secrets`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([secretPayload]);
      expect(mockSecretService.list).toHaveBeenCalledWith(company1);
    });

    it("returns 403 when agent calls (board-only route)", async () => {
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorAgent(company1),
      });
      const res = await request(app).get(`/api/companies/${company1}/secrets`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Board access required" });
      expect(mockSecretService.list).not.toHaveBeenCalled();
    });

    it("returns 403 when board user has no access to company", async () => {
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/companies/${company1}/secrets`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockSecretService.list).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/companies/:companyId/secrets", () => {
    it("returns 201 with created secret on success", async () => {
      mockSecretService.create.mockResolvedValue(secretPayload);
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/secrets`)
        .send({ name: "my-secret", value: "secret-value" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(secretPayload);
      expect(mockSecretService.create).toHaveBeenCalledWith(
        company1,
        expect.objectContaining({ name: "my-secret", value: "secret-value" }),
        expect.any(Object),
      );
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 403 when agent calls", async () => {
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorAgent(company1),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/secrets`)
        .send({ name: "my-secret", value: "secret-value" });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "Board access required" });
      expect(mockSecretService.create).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/secrets/:id/rotate", () => {
    it("returns 404 when secret not found", async () => {
      mockSecretService.getById.mockResolvedValue(null);
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/secrets/${secretId}/rotate`)
        .send({ value: "new-value" });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Secret not found" });
      expect(mockSecretService.rotate).not.toHaveBeenCalled();
    });

    it("returns 200 with rotated secret when found and actor has access", async () => {
      const rotated = { ...secretPayload, latestVersion: 2 };
      mockSecretService.getById.mockResolvedValue(secretPayload);
      mockSecretService.rotate.mockResolvedValue(rotated);
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/secrets/${secretId}/rotate`)
        .send({ value: "new-value" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(rotated);
      expect(mockSecretService.rotate).toHaveBeenCalledWith(secretId, expect.any(Object), expect.any(Object));
    });
  });

  describe("POST /api/companies/:companyId/secrets/migrate-provider", () => {
    it("returns dry-run report", async () => {
      mockMigrationService.dryRun.mockResolvedValue({
        items: [{ secretId, fromProvider: "local_encrypted", toProvider: "vault", versionCount: 1 }],
      });
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/secrets/migrate-provider`)
        .send({ targetProvider: "vault", dryRun: true });
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(mockMigrationService.dryRun).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: company1, targetProvider: "vault" }),
      );
    });

    it("applies migration and logs activity", async () => {
      mockMigrationService.apply.mockResolvedValue({
        items: [{ secretId, fromProvider: "local_encrypted", toProvider: "vault", versionsMigrated: 2 }],
      });
      const app = createRouteTestApp({
        router: secretRoutes(db, "local_encrypted"),
        principal: actorBoard([company1]),
      });
      const res = await request(app)
        .post(`/api/companies/${company1}/secrets/migrate-provider`)
        .send({ targetProvider: "vault", dryRun: false });
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(false);
      expect(mockMigrationService.apply).toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalled();
    });
  });
});
