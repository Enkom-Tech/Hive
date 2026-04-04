import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { companiesPlugin } from "../routes/companies/index.js";
import { createRouteTestFastify, principalAgent, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";
const workerInstanceId = "aaaaaaaa-e29b-41d4-a716-446655440099";
const agentId = "bbbbbbbb-e29b-41d4-a716-4466554400aa";

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
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("allows board rotate in allowed company and denies cross-company", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalBoard({ companyIds: [companyA] }),
    });

    const res1 = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/agents/${agentId}/worker-pool/rotate`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res1.statusCode).toBe(200);
    expect(rotateAutomaticWorkerPoolPlacement).toHaveBeenCalledWith(companyA, agentId);

    const res2 = await app.inject({
      method: "POST",
      url: `/api/companies/${companyB}/agents/${agentId}/worker-pool/rotate`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res2.statusCode).toBe(403);
  });

  it("denies rotate for agent principal", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/agents/${agentId}/worker-pool/rotate`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
    expect(rotateAutomaticWorkerPoolPlacement).not.toHaveBeenCalled();
  });

  it("allows board patch worker-instance drain and denies cross-company", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalBoard({ companyIds: [companyA] }),
    });

    const res1 = await app.inject({
      method: "PATCH",
      url: `/api/companies/${companyA}/worker-instances/${workerInstanceId}`,
      payload: { drainRequested: true },
      headers: { "content-type": "application/json" },
    });
    expect(res1.statusCode).toBe(200);
    expect(patchWorkerInstance).toHaveBeenCalledWith(companyA, workerInstanceId, { drainRequested: true });

    const res2 = await app.inject({
      method: "PATCH",
      url: `/api/companies/${companyB}/worker-instances/${workerInstanceId}`,
      payload: { drainRequested: true },
      headers: { "content-type": "application/json" },
    });
    expect(res2.statusCode).toBe(403);
  });
});
