import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { accessRoutes } from "../routes/access.js";
import { approvalRoutes } from "../routes/approvals.js";
import { companyRoutes } from "../routes/companies/index.js";
import { errorHandler } from "../middleware/error-handler.js";

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

function createAccessApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    (res as any).locals = {};
    next();
  });
  app.use((req, _res, next) => {
    (req as any).principal = {
      type: "user",
      id: "user-1",
      company_ids: ["company-1"],
      roles: [],
    };
    next();
  });
  app.use(
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

const approvalTestCompanyId = "550e8400-e29b-41d4-a716-446655440000";

function createCompanyApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    next();
  });
  app.use("/companies", companyRoutes(db));
  app.use(errorHandler);
  return app;
}

function createApprovalApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    next();
  });
  app.use(approvalRoutes({} as Db, false));
  app.use(errorHandler);
  return app;
}

describe("Sensitive routes validation", () => {
  describe("POST /board-claim/:token/claim", () => {
    it("returns 400 when body is missing code", async () => {
      const db = {} as unknown as Db;
      const app = createAccessApp(db);
      const res = await request(app)
        .post("/board-claim/some-token/claim")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Validation error" });
      expect(res.body.details).toBeDefined();
    });

    it("returns 400 when body has empty code", async () => {
      const db = {} as unknown as Db;
      const app = createAccessApp(db);
      const res = await request(app)
        .post("/board-claim/some-token/claim")
        .send({ code: "" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Validation error" });
    });

    it("returns 400 when body is not an object", async () => {
      const db = {} as unknown as Db;
      const app = createAccessApp(db);
      const res = await request(app)
        .post("/board-claim/some-token/claim")
        .send("not json")
        .set("Content-Type", "text/plain");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /companies/:companyId/approvals", () => {
    it("returns 400 when query status is invalid", async () => {
      const app = createApprovalApp();
      const res = await request(app)
        .get(`/companies/${approvalTestCompanyId}/approvals`)
        .query({ status: "invalid_status" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid query" });
      expect(res.body.details).toBeDefined();
    });
  });

  describe("POST /companies", () => {
    it("returns 400 when body is missing required name", async () => {
      const db = {} as unknown as Db;
      const app = createCompanyApp(db);
      const res = await request(app).post("/companies").send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Validation error" });
      expect(res.body.details).toBeDefined();
    });

    it("returns 400 when body has wrong type for name", async () => {
      const db = {} as unknown as Db;
      const app = createCompanyApp(db);
      const res = await request(app).post("/companies").send({ name: 123 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Validation error" });
      expect(res.body.details).toBeDefined();
    });
  });

  describe("GET /companies/:companyId/join-requests", () => {
    it("returns 400 when query status is invalid", async () => {
      const db = {} as unknown as Db;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).principal = {
          type: "system",
          id: "user-1",
          roles: ["instance_admin"],
        };
        next();
      });
      app.use(
        accessRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          bindHost: "localhost",
          allowedHostnames: ["localhost"],
          joinAllowedAdapterTypes: undefined,
        }),
      );
      app.use(errorHandler);
      const res = await request(app)
        .get(`/companies/${approvalTestCompanyId}/join-requests`)
        .query({ status: "invalid_status" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid query" });
      expect(res.body.details).toBeDefined();
    });
  });
});
