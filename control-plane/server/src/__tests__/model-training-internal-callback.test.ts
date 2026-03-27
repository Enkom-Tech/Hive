import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { internalHiveTrainingCallbackRoutes } from "../routes/internal-hive.js";
import { hashTrainingCallbackToken } from "../services/model-training.js";
import { errorHandler } from "../middleware/error-handler.js";

describe("internal model-training-callback", () => {
  it("returns 403 when bearer does not match run token or operator secret", async () => {
    const tokenPlain = "test-callback-token";
    const tokenHash = hashTrainingCallbackToken(tokenPlain);
    const runId = "550e8400-e29b-41d4-a716-446655440099";

    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() =>
              Promise.resolve([
                {
                  id: runId,
                  companyId: "550e8400-e29b-41d4-a716-446655440000",
                  deploymentId: "a0000000-0000-4000-8000-000000000001",
                  status: "dispatched",
                  proposedModelSlug: "x",
                  resultBaseUrl: null,
                  resultMetadata: {},
                  callbackTokenHash: tokenHash,
                  promotedInferenceModelId: null,
                  promotedAt: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  agentId: null,
                  sourceInferenceModelId: null,
                  runnerKind: "http_json",
                  runnerTargetUrl: null,
                  externalJobRef: null,
                  lastCallbackDigest: null,
                  error: null,
                  datasetFilterSpec: null,
                  idempotencyKey: null,
                },
              ]),
            ),
          })),
        })),
      })),
    } as unknown as import("@hive/db").Db;

    const app = express();
    app.use(express.json());
    app.use(
      "/internal/hive",
      internalHiveTrainingCallbackRoutes(db, { internalOperatorSecret: "operator-secret" }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .post("/internal/hive/model-training-callback")
      .set("Authorization", "Bearer wrong-token")
      .send({
        runId,
        status: "running",
        resultMetadata: {},
      })
      .expect(403);

    expect(String(res.body?.error ?? res.text)).toMatch(/authorization/i);
  });

  it("accepts operator secret for callback", async () => {
    const runId = "550e8400-e29b-41d4-a716-446655440088";
    const tokenHash = hashTrainingCallbackToken("unused");

    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() =>
              Promise.resolve([
                {
                  id: runId,
                  companyId: "550e8400-e29b-41d4-a716-446655440000",
                  deploymentId: "a0000000-0000-4000-8000-000000000001",
                  status: "dispatched",
                  proposedModelSlug: "x",
                  resultBaseUrl: null,
                  resultMetadata: {},
                  callbackTokenHash: tokenHash,
                  promotedInferenceModelId: null,
                  promotedAt: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  agentId: null,
                  sourceInferenceModelId: null,
                  runnerKind: "http_json",
                  runnerTargetUrl: null,
                  externalJobRef: null,
                  lastCallbackDigest: null,
                  error: null,
                  datasetFilterSpec: null,
                  idempotencyKey: null,
                },
              ]),
            ),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                {
                  id: runId,
                  status: "running",
                  callbackTokenHash: tokenHash,
                  companyId: "550e8400-e29b-41d4-a716-446655440000",
                  deploymentId: "a0000000-0000-4000-8000-000000000001",
                  proposedModelSlug: "x",
                  resultBaseUrl: null,
                  resultMetadata: {},
                  promotedInferenceModelId: null,
                  promotedAt: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  agentId: null,
                  sourceInferenceModelId: null,
                  runnerKind: "http_json",
                  runnerTargetUrl: null,
                  externalJobRef: null,
                  lastCallbackDigest: "digest",
                  error: null,
                  datasetFilterSpec: null,
                  idempotencyKey: null,
                },
              ]),
            ),
          })),
        })),
      })),
    } as unknown as import("@hive/db").Db;

    const app = express();
    app.use(express.json());
    app.use(
      "/internal/hive",
      internalHiveTrainingCallbackRoutes(db, { internalOperatorSecret: "operator-secret" }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .post("/internal/hive/model-training-callback")
      .set("Authorization", "Bearer operator-secret")
      .send({
        runId,
        status: "running",
        resultMetadata: {},
      })
      .expect(200);

    expect(res.body.status).toBe("running");
  });

  it("duplicate identical callback does not invoke update twice (idempotent digest)", async () => {
    const tokenPlain = "idempotent-callback-token";
    const tokenHash = hashTrainingCallbackToken(tokenPlain);
    const runId = "550e8400-e29b-41d4-a716-446655440077";

    const run = {
      id: runId,
      companyId: "550e8400-e29b-41d4-a716-446655440000",
      deploymentId: "a0000000-0000-4000-8000-000000000001",
      status: "dispatched",
      proposedModelSlug: "x",
      resultBaseUrl: null,
      resultMetadata: {} as Record<string, unknown>,
      callbackTokenHash: tokenHash,
      promotedInferenceModelId: null,
      promotedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      agentId: null,
      sourceInferenceModelId: null,
      runnerKind: "http_json",
      runnerTargetUrl: null,
      externalJobRef: null,
      lastCallbackDigest: null as string | null,
      error: null,
      datasetFilterSpec: null,
      idempotencyKey: null,
    };

    const updateSpy = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([run])),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((vals: Record<string, unknown>) => {
          updateSpy();
          Object.assign(run, vals);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve([{ ...run }])),
            })),
          };
        }),
      })),
    } as unknown as import("@hive/db").Db;

    const app = express();
    app.use(express.json());
    app.use("/internal/hive", internalHiveTrainingCallbackRoutes(db, {}));
    app.use(errorHandler);

    const body = { runId, status: "running" as const, resultMetadata: {} };

    await request(app)
      .post("/internal/hive/model-training-callback")
      .set("Authorization", `Bearer ${tokenPlain}`)
      .send(body)
      .expect(200);

    await request(app)
      .post("/internal/hive/model-training-callback")
      .set("Authorization", `Bearer ${tokenPlain}`)
      .send(body)
      .expect(200);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(run.lastCallbackDigest).toBeTruthy();
  });
});
