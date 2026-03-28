import { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies/index.js";
import { createRouteTestApp, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as import("@hive/db").Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";

function apiRouter() {
  const r = Router();
  r.use("/companies", companyRoutes(mockDb));
  return r;
}

const createDroneProvisioningToken = vi.fn(() =>
  Promise.resolve({
    token: "hive_dpv_testtoken",
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
    createWorkerInstanceLinkEnrollmentToken: vi.fn(),
    createDroneProvisioningToken,
    bindManagedWorkerAgentToInstance: vi.fn(),
    unbindManagedWorkerAgentFromInstance: vi.fn(),
  }),
  logActivity: vi.fn(() => Promise.resolve()),
}));

describe("POST /api/companies/:companyId/drone-provisioning-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 and token when board has company access", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const path = `/api/companies/${companyA}/drone-provisioning-tokens`;
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toBe("hive_dpv_testtoken");
    expect(createDroneProvisioningToken).toHaveBeenCalledWith(companyA, 900);
  });

  it("returns 403 when board cannot access company", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const path = `/api/companies/${companyB}/drone-provisioning-tokens`;
    await request(app).post(path).send({}).expect(403);
    expect(createDroneProvisioningToken).not.toHaveBeenCalled();
  });
});
