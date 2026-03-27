import { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  gatewayVirtualKeys,
  hiveDeployments,
  inferenceModels,
  modelTrainingRuns,
} from "@hive/db";
import { companyRoutes } from "../routes/companies.js";
import { createRouteTestApp, principalBoard } from "./helpers/route-app.js";

const companyId = "550e8400-e29b-41d4-a716-446655440000";
const deploymentId = "a0000000-0000-4000-8000-000000000001";
const runId = "550e8400-e29b-41d4-a716-4466554400aa";

type ImRow = {
  id: string;
  deploymentId: string;
  companyId: string | null;
  modelSlug: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function listEffectiveChatModelsForRouterLike(
  modelRows: ImRow[],
  cid: string,
  depId: string,
): ImRow[] {
  const filtered = modelRows.filter(
    (r) =>
      r.deploymentId === depId &&
      r.enabled === true &&
      r.kind === "chat" &&
      (r.companyId === null || r.companyId === cid),
  );
  const bySlug = new Map<string, ImRow>();
  for (const r of filtered) {
    if (r.companyId === cid) {
      bySlug.set(r.modelSlug, r);
    }
  }
  for (const r of filtered) {
    if (r.companyId == null && !bySlug.has(r.modelSlug)) {
      bySlug.set(r.modelSlug, r);
    }
  }
  return [...bySlug.values()];
}

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(() =>
      Promise.resolve({
        id: companyId,
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

function createStatefulDb() {
  const inferenceRows: ImRow[] = [];
  const company = {
    id: companyId,
    deploymentId,
    requireApprovalForModelPromotion: false,
  };
  const run = {
    id: runId,
    companyId,
    deploymentId,
    agentId: null,
    sourceInferenceModelId: null,
    proposedModelSlug: "promoted-slug",
    status: "succeeded",
    runnerKind: "http_json",
    runnerTargetUrl: null,
    externalJobRef: null,
    resultBaseUrl: "http://trained/v1",
    resultMetadata: {},
    lastCallbackDigest: null,
    promotedInferenceModelId: null,
    promotedAt: null,
    error: null,
    callbackTokenHash: "abc",
    datasetFilterSpec: null,
    idempotencyKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const db = {
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          if (table === hiveDeployments) {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([{ modelGatewayBackend: "hive_router" }]);
                  },
                };
              },
            };
          }
          if (table === modelTrainingRuns) {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([run]);
                  },
                };
              },
            };
          }
          if (table === companies) {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([company]);
                  },
                };
              },
            };
          }
          if (table === inferenceModels) {
            return {
              where() {
                return {
                  limit() {
                    const slug = run.proposedModelSlug;
                    const found = inferenceRows.filter(
                      (r) =>
                        r.deploymentId === company.deploymentId &&
                        r.modelSlug === slug &&
                        r.companyId === companyId,
                    );
                    return Promise.resolve(found.slice(0, 1));
                  },
                  then(onFulfilled: (v: unknown) => unknown) {
                    const rows = listEffectiveChatModelsForRouterLike(
                      inferenceRows,
                      companyId,
                      company.deploymentId,
                    );
                    return Promise.resolve(rows).then(onFulfilled);
                  },
                };
              },
            };
          }
          if (table === gatewayVirtualKeys) {
            return {
              where() {
                return {
                  then(onFulfilled: (v: unknown) => unknown) {
                    return Promise.resolve([]).then(onFulfilled);
                  },
                };
              },
            };
          }
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve([]);
                },
                then(onFulfilled: (v: unknown) => unknown) {
                  return Promise.resolve([]).then(onFulfilled);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown>) {
          return {
            returning: async () => {
              if (table !== inferenceModels) return [];
              const row: ImRow = {
                id: "new-im-1",
                deploymentId: String(vals.deploymentId),
                companyId: (vals.companyId as string) ?? null,
                modelSlug: String(vals.modelSlug),
                kind: String(vals.kind),
                baseUrl: String(vals.baseUrl),
                enabled: Boolean(vals.enabled),
                createdAt: new Date(),
                updatedAt: vals.updatedAt as Date,
              };
              inferenceRows.push(row);
              return [row];
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            where() {
              return {
                returning: async () => {
                  if (table === modelTrainingRuns) {
                    Object.assign(run, vals);
                    return [{ ...run }];
                  }
                  return [];
                },
              };
            },
          };
        },
      };
    },
  } as unknown as import("@hive/db").Db;

  return db;
}

function servicesMockedRouter(db: import("@hive/db").Db) {
  const r = Router();
  r.use("/companies", companyRoutes(db));
  return r;
}

describe("model training promote and inference router config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET inference-router-config includes model after POST promote", async () => {
    const db = createStatefulDb();
    const app = createRouteTestApp({
      router: servicesMockedRouter(db),
      principal: principalBoard({ companyIds: [companyId], isSystem: true }),
    });

    await request(app)
      .post(`/api/companies/${companyId}/model-training-runs/${runId}/promote`)
      .send({})
      .expect(200);

    const res = await request(app).get(`/api/companies/${companyId}/inference-router-config`).expect(200);

    expect(res.body.models.models).toEqual(
      expect.arrayContaining([{ id: "promoted-slug", base_url: "http://trained/v1" }]),
    );
  });
});
