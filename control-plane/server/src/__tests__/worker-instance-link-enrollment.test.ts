import { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { createRouteTestApp, principalAgent, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as import("@hive/db").Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";
const workerInstanceId = "aaaaaaaa-e29b-41d4-a716-446655440099";

function apiRouter() {
  const r = Router();
  r.use("/companies", companyRoutes(mockDb));
  return r;
}

const createWorkerInstanceLinkEnrollmentToken = vi.fn(() =>
  Promise.resolve({
    token: "hive_wen_inst_test",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  }),
);

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  agentService: () => ({
    createWorkerInstanceLinkEnrollmentToken,
    createDroneProvisioningToken: vi.fn(() =>
      Promise.resolve({
        token: "hive_dpv_test",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
    ),
    bindManagedWorkerAgentToInstance: vi.fn(() => Promise.resolve()),
    unbindManagedWorkerAgentFromInstance: vi.fn(() => Promise.resolve()),
  }),
  logActivity: vi.fn(() => Promise.resolve()),
}));

describe("POST /api/companies/:companyId/worker-instances/:workerInstanceId/link-enrollment-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 when board user has access to the company", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const path = `/api/companies/${companyA}/worker-instances/${workerInstanceId}/link-enrollment-tokens`;
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toBe("hive_wen_inst_test");
    expect(res.body.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(createWorkerInstanceLinkEnrollmentToken).toHaveBeenCalledWith(companyA, workerInstanceId, 900);
  });

  it("returns 403 when board user cannot access company in URL", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const path = `/api/companies/${companyB}/worker-instances/${workerInstanceId}/link-enrollment-tokens`;
    await request(app).post(path).send({}).expect(403);
    expect(createWorkerInstanceLinkEnrollmentToken).not.toHaveBeenCalled();
  });

  it("returns 403 when actor is an agent", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalAgent({ agentId: "bbbbbbbb-e29b-41d4-a716-4466554400aa", companyId: companyA }),
    });
    const path = `/api/companies/${companyA}/worker-instances/${workerInstanceId}/link-enrollment-tokens`;
    await request(app).post(path).send({}).expect(403);
    expect(createWorkerInstanceLinkEnrollmentToken).not.toHaveBeenCalled();
  });

  it("returns 403 when unauthenticated (board required)", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: null,
    });
    const path = `/api/companies/${companyA}/worker-instances/${workerInstanceId}/link-enrollment-tokens`;
    await request(app).post(path).send({}).expect(403);
  });
});
