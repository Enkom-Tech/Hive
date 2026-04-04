import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { accessPlugin } from "../routes/access.js";
import { approvalsPlugin } from "../routes/approvals.js";
import { companiesPlugin } from "../routes/companies/company-routes.js";
import { createRouteTestFastify, principalBoard } from "./helpers/route-app.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  };
});

const accessOpts = {
  deploymentMode: "authenticated" as const,
  deploymentExposure: "private" as const,
  bindHost: "localhost",
  allowedHostnames: ["localhost"],
  joinAllowedAdapterTypes: undefined,
};

const approvalTestCompanyId = "550e8400-e29b-41d4-a716-446655440000";

describe("Sensitive routes validation", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  describe("POST /api/board-claim/:token/claim", () => {
    it("returns 400 when body is missing code", async () => {
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db: {} as Db, ...accessOpts }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/board-claim/some-token/claim",
        payload: {},
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
    });

    it("returns 400 when body has empty code", async () => {
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db: {} as Db, ...accessOpts }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/board-claim/some-token/claim",
        payload: { code: "" },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("GET /api/companies/:companyId/approvals", () => {
    it("returns 400 when query status is invalid", async () => {
      app = await createRouteTestFastify({
        plugin: async (fastify) => approvalsPlugin(fastify, { db: {} as Db, strictSecretsMode: false }),
        principal: principalBoard({ companyIds: [approvalTestCompanyId], isSystem: true }),
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/companies/${approvalTestCompanyId}/approvals?status=invalid_status`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "Invalid query" });
      expect(res.json().details).toBeDefined();
    });
  });

  describe("POST /api/companies", () => {
    it("returns 400 when body is missing required name", async () => {
      app = await createRouteTestFastify({
        plugin: async (fastify) =>
          companiesPlugin(fastify, { db: {} as Db, deploymentMode: "authenticated", deploymentExposure: "private" }),
        principal: principalBoard({ companyIds: [], isSystem: true }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/companies",
        payload: {},
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
    });

    it("returns 400 when body has wrong type for name", async () => {
      app = await createRouteTestFastify({
        plugin: async (fastify) =>
          companiesPlugin(fastify, { db: {} as Db, deploymentMode: "authenticated", deploymentExposure: "private" }),
        principal: principalBoard({ companyIds: [], isSystem: true }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/companies",
        payload: { name: 123 },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("GET /api/companies/:companyId/join-requests", () => {
    it("returns 400 when query status is invalid", async () => {
      app = await createRouteTestFastify({
        plugin: async (fastify) => accessPlugin(fastify, { db: {} as Db, ...accessOpts }),
        principal: principalBoard({ companyIds: [], isSystem: true }),
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/companies/${approvalTestCompanyId}/join-requests?status=invalid_status`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "Invalid query" });
      expect(res.json().details).toBeDefined();
    });
  });
});
