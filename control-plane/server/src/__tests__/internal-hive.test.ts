import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { internalHiveOperatorPlugin } from "../routes/internal-hive.js";
import { createRouteTestFastify } from "./helpers/route-app.js";

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
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function buildApp(secret: string): Promise<FastifyInstance> {
    return createRouteTestFastify({
      plugin: async (fastify) => {
        await internalHiveOperatorPlugin(fastify, { db: mockDb, operatorSecret: secret });
      },
    });
  }

  afterEach(async () => {
    await app?.close();
  });

  it("rejects missing bearer token", async () => {
    app = await buildApp("op-secret");
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/hive/inference-metering",
      payload: {
        companyId,
        source: "gateway_aggregate",
        provider: "model_gateway",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 2,
        costCents: 0,
        occurredAt,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("creates gateway_aggregate cost event", async () => {
    app = await buildApp("op-secret");
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/hive/inference-metering",
      headers: { authorization: "Bearer op-secret" },
      payload: {
        companyId,
        source: "gateway_aggregate",
        agentId: null,
        provider: "model_gateway",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 2,
        costCents: 0,
        occurredAt,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe("cost-event-1");
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
    app = await buildApp("op-secret");
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/hive/inference-metering",
      headers: { authorization: "Bearer op-secret" },
      payload: {
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
      },
    });
    expect(res.statusCode).toBe(201);
    expect(createEvent).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ gatewayMeteringKey: "idem-test-1" }),
    );
  });
});
