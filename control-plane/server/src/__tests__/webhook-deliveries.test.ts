/// <reference path="../types/express.d.ts" />
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_STATUS_TODO, ISSUE_STATUS_DONE } from "@hive/shared";
import { webhookDeliveryRoutes } from "../routes/webhook-deliveries.js";
import { errorHandler } from "../middleware/error-handler.js";

const getByIdMock = vi.fn();

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    issueService: () => ({ getById: getByIdMock }),
  };
});

function createApp(db: Parameters<typeof webhookDeliveryRoutes>[0], actor: {
  type: "board" | "agent";
  userId?: string;
  agentId?: string;
  companyId?: string;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal =
      actor.type === "board"
        ? { type: "system", id: actor.userId ?? "board", roles: [] }
        : { type: "agent", id: actor.agentId ?? "agent-1", company_id: actor.companyId ?? "company-A", roles: [] };
    next();
  });
  app.use(webhookDeliveryRoutes(db));
  app.use(errorHandler);
  return app;
}

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "660e8400-e29b-41d4-a716-446655440001";
const issueId = "770e8400-e29b-41d4-a716-446655440002";
const agentId = "880e8400-e29b-41d4-a716-446655440003";

function mockDb(deliveries: Array<Record<string, unknown>> = []) {
  const whereResult = {
    orderBy: () => ({
      limit: () => Promise.resolve(deliveries),
    }),
    // deliverWorkAvailable(agentId, companyId, issueId, db) does db.select().from(agents).where(...).limit(1)
    limit: () => Promise.resolve([]),
  };
  return {
    select: () => ({
      from: () => ({
        where: () => whereResult,
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve(),
    }),
  } as unknown as Parameters<typeof webhookDeliveryRoutes>[0];
}

describe("GET /companies/:companyId/webhook-deliveries", () => {
  beforeEach(() => {
    getByIdMock.mockReset();
  });

  it("returns 200 with deliveries array for company", async () => {
    const db = mockDb([
      {
        id: "d1",
        companyId: companyA,
        agentId,
        issueId,
        eventType: "work_available",
        status: "failed",
        httpStatusCode: 500,
        responseBodyExcerpt: null,
        durationMs: 100,
        attemptNumber: 1,
        createdAt: new Date(),
      },
    ]);
    const app = createApp(db, { type: "board" });
    const res = await request(app).get(`/companies/${companyA}/webhook-deliveries`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0].status).toBe("failed");
    expect(res.body.deliveries[0].companyId).toBe(companyA);
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const db = mockDb([]);
    const app = createApp(db, {
      type: "agent",
      agentId,
      companyId: companyA,
    });
    const res = await request(app).get(`/companies/${companyB}/webhook-deliveries`);
    expect(res.status).toBe(403);
  });

  it("returns 200 when agent key calls with own company id", async () => {
    const db = mockDb([]);
    const app = createApp(db, {
      type: "agent",
      agentId,
      companyId: companyA,
    });
    const res = await request(app).get(`/companies/${companyA}/webhook-deliveries`);
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toEqual([]);
  });
});

describe("POST /companies/:companyId/webhook-deliveries/retry", () => {
  beforeEach(() => {
    getByIdMock.mockReset();
  });

  it("returns 202 when issue is assigned to agent and workable status", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyA,
      assigneeAgentId: agentId,
      status: ISSUE_STATUS_TODO,
    });
    const db = mockDb([]);
    const app = createApp(db, { type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/webhook-deliveries/retry`)
      .send({ issueId, agentId });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
  });

  it("returns 404 when issue not found", async () => {
    getByIdMock.mockResolvedValueOnce(null);
    const db = mockDb([]);
    const app = createApp(db, { type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/webhook-deliveries/retry`)
      .send({ issueId, agentId });
    expect(res.status).toBe(404);
  });

  it("returns 403 when issue belongs to another company", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyB,
      assigneeAgentId: agentId,
      status: ISSUE_STATUS_TODO,
    });
    const db = mockDb([]);
    const app = createApp(db, { type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/webhook-deliveries/retry`)
      .send({ issueId, agentId });
    expect(res.status).toBe(403);
  });

  it("returns 422 when issue is not assigned to agent", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyA,
      assigneeAgentId: "other-agent-id",
      status: ISSUE_STATUS_TODO,
    });
    const db = mockDb([]);
    const app = createApp(db, { type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/webhook-deliveries/retry`)
      .send({ issueId, agentId });
    expect(res.status).toBe(422);
  });

  it("returns 422 when issue status is not workable", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyA,
      assigneeAgentId: agentId,
      status: ISSUE_STATUS_DONE,
    });
    const db = mockDb([]);
    const app = createApp(db, { type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/webhook-deliveries/retry`)
      .send({ issueId, agentId });
    expect(res.status).toBe(422);
  });
});
