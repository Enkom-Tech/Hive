import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalHiveRoutes } from "../routes/internal-hive.js";
import { errorHandler } from "../middleware/error-handler.js";

const mockDb = {} as import("@hive/db").Db;
const companyId = "550e8400-e29b-41d4-a716-446655440000";

const createEvent = vi.fn(() =>
  Promise.resolve({
    id: "cost-event-1",
    companyId,
    source: "gateway_aggregate",
  }),
);

vi.mock("../services/costs.js", () => ({
  costService: () => ({ createEvent }),
}));

describe("internal hive routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function app(secret: string) {
    const a = express();
    a.use(express.json());
    a.use("/internal/hive", internalHiveRoutes(mockDb, { operatorSecret: secret }));
    a.use(errorHandler);
    return a;
  }

  it("rejects missing bearer token", async () => {
    const occurredAt = new Date().toISOString();
    await request(app("op-secret"))
      .post("/internal/hive/inference-metering")
      .send({
        companyId,
        source: "gateway_aggregate",
        provider: "model_gateway",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 2,
        costCents: 0,
        occurredAt,
      })
      .expect(401);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("creates gateway_aggregate cost event", async () => {
    const occurredAt = new Date().toISOString();
    const res = await request(app("op-secret"))
      .post("/internal/hive/inference-metering")
      .set("Authorization", "Bearer op-secret")
      .send({
        companyId,
        source: "gateway_aggregate",
        agentId: null,
        provider: "model_gateway",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 2,
        costCents: 0,
        occurredAt,
      })
      .expect(201);
    expect(res.body.id).toBe("cost-event-1");
    expect(createEvent).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        source: "gateway_aggregate",
        provider: "model_gateway",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 2,
        costCents: 0,
      }),
    );
  });

  it("forwards idempotencyKey to gatewayMeteringKey", async () => {
    const occurredAt = new Date().toISOString();
    await request(app("op-secret"))
      .post("/internal/hive/inference-metering")
      .set("Authorization", "Bearer op-secret")
      .send({
        companyId,
        source: "gateway_aggregate",
        agentId: null,
        provider: "model_gateway",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 2,
        costCents: 0,
        occurredAt,
        idempotencyKey: "idem-test-1",
      })
      .expect(201);
    expect(createEvent).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ gatewayMeteringKey: "idem-test-1" }),
    );
  });
});
