import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { companiesPlugin } from "../routes/companies/index.js";
import { createRouteTestFastify, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";

const listWorkerIdentitySlots = vi.fn(() =>
  Promise.resolve([
    {
      id: "slot-1",
      companyId: companyA,
      profileKey: "eng",
      displayNamePrefix: "Engineer",
      desiredCount: 2,
      workerPlacementMode: "automatic",
      operationalPosture: "active",
      adapterType: "managed_worker",
      adapterConfig: {},
      runtimeConfig: {},
      role: "general",
      enabled: true,
      lastReconciledAt: null,
      lastReconcileError: null,
      lastReconcileSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]),
);

const getWorkerIdentityAutomationStatus = vi.fn();

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(() => Promise.resolve({ id: companyA, name: "Co" })),
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
    listWorkerIdentitySlots,
    getWorkerIdentityAutomationStatus,
    createWorkerIdentitySlot: vi.fn(),
    patchWorkerIdentitySlot: vi.fn(),
    deleteWorkerIdentitySlot: vi.fn(),
    createWorkerInstanceLinkEnrollmentToken: vi.fn(),
    createDroneProvisioningToken: vi.fn(),
    bindManagedWorkerAgentToInstance: vi.fn(),
    unbindManagedWorkerAgentFromInstance: vi.fn(),
    rotateAutomaticWorkerPoolPlacement: vi.fn(),
    patchWorkerInstance: vi.fn(),
    deleteWorkerInstance: vi.fn(),
  }),
  logActivity: vi.fn(() => Promise.resolve()),
}));

describe("worker identity slots routes (authz shape)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    getWorkerIdentityAutomationStatus.mockResolvedValue({
      identityAutomationEnabled: true,
      slots: [],
      unboundAutomaticAgentIds: [],
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  it("lists slots for allowed company", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        companiesPlugin(fastify, {
          db: mockDb,
          workerIdentityAutomationEnabled: true,
          apiPublicBaseUrl: "https://board.example.com",
        }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/worker-identity-slots` });
    expect(res.statusCode).toBe(200);
    expect(listWorkerIdentitySlots).toHaveBeenCalledWith(companyA);
    expect(res.json().slots).toHaveLength(1);
    expect(res.json().slots[0].profileKey).toBe("eng");
  });

  it("returns 403 for company outside principal", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        companiesPlugin(fastify, {
          db: mockDb,
          workerIdentityAutomationEnabled: true,
          apiPublicBaseUrl: "https://board.example.com",
        }),
      principal: principalBoard({ companyIds: ["00000000-0000-0000-0000-000000000001"] }),
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/worker-identity-slots` });
    expect(res.statusCode).toBe(403);
    expect(listWorkerIdentitySlots).not.toHaveBeenCalled();
  });
});
