import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { companiesPlugin } from "../routes/companies/index.js";
import { createRouteTestFastify, principalAgent, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";
const workerInstanceId = "aaaaaaaa-e29b-41d4-a716-446655440099";

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
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 201 when board user has access to the company", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/worker-instances/${workerInstanceId}/link-enrollment-tokens`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBe("hive_wen_inst_test");
    expect(res.json().expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(createWorkerInstanceLinkEnrollmentToken).toHaveBeenCalledWith(companyA, workerInstanceId, 900);
  });

  it("returns 403 when board user cannot access company in URL", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyB}/worker-instances/${workerInstanceId}/link-enrollment-tokens`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
    expect(createWorkerInstanceLinkEnrollmentToken).not.toHaveBeenCalled();
  });

  it("returns 403 when actor is an agent", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: principalAgent({ agentId: "bbbbbbbb-e29b-41d4-a716-4466554400aa", companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/worker-instances/${workerInstanceId}/link-enrollment-tokens`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
    expect(createWorkerInstanceLinkEnrollmentToken).not.toHaveBeenCalled();
  });

  it("returns 403 when unauthenticated (assertBoard before session checks)", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: mockDb }),
      principal: null,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/worker-instances/${workerInstanceId}/link-enrollment-tokens`,
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
  });
});
