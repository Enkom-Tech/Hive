import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { companiesPlugin } from "../routes/companies/index.js";
import { createRouteTestFastify, principalBoard } from "./helpers/route-app.js";

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const deploymentId = "a0000000-0000-4000-8000-000000000001";

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(() =>
      Promise.resolve({
        id: companyA,
        name: "Co",
        deploymentId,
      }),
    ),
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
    listWorkerIdentitySlots: vi.fn(),
    getWorkerIdentityAutomationStatus: vi.fn(),
    createWorkerIdentitySlot: vi.fn(),
    patchWorkerIdentitySlot: vi.fn(),
    deleteWorkerIdentitySlot: vi.fn(),
    createWorkerInstanceLinkEnrollmentToken: vi.fn(),
    createDroneProvisioningToken: vi.fn(),
    bindManagedWorkerAgentToInstance: vi.fn(),
    unbindManagedWorkerAgentToInstance: vi.fn(),
    rotateAutomaticWorkerPoolPlacement: vi.fn(),
    patchWorkerInstance: vi.fn(),
    deleteWorkerInstance: vi.fn(),
  }),
  logActivity: vi.fn(() => Promise.resolve()),
}));

vi.mock("../workers/worker-link-registry.js", () => ({
  forceDisconnectWorkerInstance: vi.fn(),
}));

describe("inference catalog and gateway virtual keys", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("GET inference-router-config prefers company slug over deployment default", async () => {
    let q = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((..._args: unknown[]) => {
            q += 1;
            if (q === 1) {
              return {
                limit: vi.fn(() => Promise.resolve([{ modelGatewayBackend: "hive_router" }])),
              };
            }
            if (q === 2) {
              return Promise.resolve([
                {
                  id: "m1",
                  deploymentId,
                  companyId: companyA,
                  modelSlug: "same-slug",
                  kind: "chat",
                  baseUrl: "http://company/v1",
                  enabled: true,
                },
                {
                  id: "m2",
                  deploymentId,
                  companyId: null,
                  modelSlug: "same-slug",
                  kind: "chat",
                  baseUrl: "http://dep/v1",
                  enabled: true,
                },
                {
                  id: "m3",
                  deploymentId,
                  companyId: null,
                  modelSlug: "dep-only",
                  kind: "chat",
                  baseUrl: "http://dep-only/v1",
                  enabled: true,
                },
              ]);
            }
            return Promise.resolve([{ sha256: "abc", company_id: companyA }]);
          }),
        })),
      })),
    } as unknown as import("@hive/db").Db;

    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/inference-router-config` });
    expect(res.statusCode).toBe(200);
    expect(res.json().modelGatewayBackend).toBe("hive_router");
    expect(res.json().models.models).toEqual(
      expect.arrayContaining([
        { id: "same-slug", base_url: "http://company/v1" },
        { id: "dep-only", base_url: "http://dep-only/v1" },
      ]),
    );
    expect(res.json().models.models).toHaveLength(2);
    expect(res.json().virtualKeys.keys).toEqual([{ sha256: "abc", company_id: companyA }]);
  });

  it("POST inference-models creates a row", async () => {
    const insertReturning = vi.fn(() =>
      Promise.resolve([
        {
          id: "new-im",
          deploymentId,
          companyId: companyA,
          modelSlug: "vllm:llama",
          kind: "chat",
          baseUrl: "http://llama/v1",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    const db = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as unknown as import("@hive/db").Db;

    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/inference-models`,
      payload: {
        modelSlug: "vllm:llama",
        kind: "chat",
        baseUrl: "http://llama/v1",
        enabled: true,
      },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().modelSlug).toBe("vllm:llama");
    expect(db.insert).toHaveBeenCalled();
  });

  it("POST gateway-virtual-keys returns a one-time token", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{ modelGatewayBackend: "hive_router" }])),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((vals: { keyPrefix: string; label: string | null }) => ({
          returning: vi.fn(() =>
            Promise.resolve([
              {
                id: "vk-new",
                keyPrefix: vals.keyPrefix,
                label: vals.label,
                createdAt: new Date(),
                keyKind: "hive_router",
              },
            ]),
          ),
        })),
      })),
    } as unknown as import("@hive/db").Db;

    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/gateway-virtual-keys`,
      payload: { label: "ci" },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^hive_gvk_[a-f0-9]{48}$/);
    expect(res.json().keyPrefix).toBe(res.json().token.slice(0, 16));
    expect(db.insert).toHaveBeenCalled();
  });

  it("GET gateway-virtual-keys lists key metadata", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() =>
              Promise.resolve([
                {
                  id: "vk1",
                  keyPrefix: "hive_gvk_abcd",
                  keyKind: "hive_router",
                  bifrostVirtualKeyId: null,
                  label: null,
                  createdAt: new Date().toISOString(),
                  revokedAt: null,
                },
              ]),
            ),
          })),
        })),
      })),
    } as unknown as import("@hive/db").Db;

    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db }),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/gateway-virtual-keys` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].keyPrefix).toBe("hive_gvk_abcd");
  });
});
