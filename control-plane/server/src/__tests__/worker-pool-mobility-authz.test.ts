import { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { createRouteTestApp, principalAgent, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as import("@hive/db").Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";
const workerInstanceId = "aaaaaaaa-e29b-41d4-a716-446655440099";
const agentId = "bbbbbbbb-e29b-41d4-a716-4466554400aa";

function apiRouter() {
  const r = Router();
  r.use("/companies", companyRoutes(mockDb));
  return r;
}

const rotateAutomaticWorkerPoolPlacement = vi.fn(() =>
  Promise.resolve({
    rotated: true,
    fromWorkerInstanceId: "wi-old",
    toWorkerInstanceId: "wi-new",
  }),
);

const patchWorkerInstance = vi.fn(() =>
  Promise.resolve({
    id: workerInstanceId,
    stableInstanceId: "stable-1",
    labels: {},
    drainRequestedAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    capacityHint: null,
    displayLabel: null,
    updatedAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    drainEvacuation: { evacuatedAgentIds: [agentId], skippedAgentIds: [] },
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
    createDroneProvisioningToken: vi.fn(),
    bindManagedWorkerAgentToInstance: vi.fn(),
    unbindManagedWorkerAgentFromInstance: vi.fn(),
    rotateAutomaticWorkerPoolPlacement,
    patchWorkerInstance,
  }),
  logActivity: vi.fn(() => Promise.resolve()),
}));

describe("worker pool mobility authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows board rotate in allowed company and denies cross-company", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalBoard({ companyIds: [companyA] }),
    });

    await request(app)
      .post(`/api/companies/${companyA}/agents/${agentId}/worker-pool/rotate`)
      .send({})
      .expect(200);
    expect(rotateAutomaticWorkerPoolPlacement).toHaveBeenCalledWith(companyA, agentId);

    await request(app)
      .post(`/api/companies/${companyB}/agents/${agentId}/worker-pool/rotate`)
      .send({})
      .expect(403);
  });

  it("denies rotate for agent principal", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post(`/api/companies/${companyA}/agents/${agentId}/worker-pool/rotate`)
      .send({})
      .expect(403);
    expect(rotateAutomaticWorkerPoolPlacement).not.toHaveBeenCalled();
  });

  it("allows board patch worker-instance drain and denies cross-company", async () => {
    const app = createRouteTestApp({
      router: apiRouter(),
      principal: principalBoard({ companyIds: [companyA] }),
    });

    await request(app)
      .patch(`/api/companies/${companyA}/worker-instances/${workerInstanceId}`)
      .send({ drainRequested: true })
      .expect(200);
    expect(patchWorkerInstance).toHaveBeenCalledWith(companyA, workerInstanceId, { drainRequested: true });

    await request(app)
      .patch(`/api/companies/${companyB}/worker-instances/${workerInstanceId}`)
      .send({ drainRequested: true })
      .expect(403);
  });
});
