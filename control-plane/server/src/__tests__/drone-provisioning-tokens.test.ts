import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { companiesPlugin } from "../routes/companies/index.js";
import { createRouteTestFastify, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";

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
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 201 and token when board has company access", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/drone-provisioning-tokens`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBe("hive_dpv_testtoken");
    expect(createDroneProvisioningToken).toHaveBeenCalledWith(companyA, 900);
  });

  it("returns 403 when board cannot access company", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyB}/drone-provisioning-tokens`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
    expect(createDroneProvisioningToken).not.toHaveBeenCalled();
  });
});
