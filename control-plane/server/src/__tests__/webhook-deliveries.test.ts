import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { ISSUE_STATUS_TODO, ISSUE_STATUS_DONE } from "@hive/shared";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { webhookDeliveriesPlugin } from "../routes/webhook-deliveries.js";

const getByIdMock = vi.fn();

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    issueService: () => ({ getById: getByIdMock }),
  };
});

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "660e8400-e29b-41d4-a716-446655440001";
const issueId = "770e8400-e29b-41d4-a716-446655440002";
const agentId = "880e8400-e29b-41d4-a716-446655440003";

function mockDb(deliveries: Array<Record<string, unknown>> = []) {
  const whereResult = {
    orderBy: () => ({
      limit: () => Promise.resolve(deliveries),
    }),
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
  } as unknown as Db;
}

const boardPrincipal: Principal = { type: "system", id: "board", roles: [] };

describe("GET /api/companies/:companyId/webhook-deliveries", () => {
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
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/webhook-deliveries` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().deliveries)).toBe(true);
    expect(res.json().deliveries).toHaveLength(1);
    expect(res.json().deliveries[0].status).toBe("failed");
    expect(res.json().deliveries[0].companyId).toBe(companyA);
    await app.close();
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const db = mockDb([]);
    const principal: Principal = {
      type: "agent",
      id: agentId,
      company_id: companyA,
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyB}/webhook-deliveries` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 200 when agent key calls with own company id", async () => {
    const db = mockDb([]);
    const principal: Principal = {
      type: "agent",
      id: agentId,
      company_id: companyA,
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/webhook-deliveries` });
    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toEqual([]);
    await app.close();
  });
});

describe("POST /api/companies/:companyId/webhook-deliveries/retry", () => {
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
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/webhook-deliveries/retry`,
      payload: { issueId, agentId },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);
    await app.close();
  });

  it("returns 404 when issue not found", async () => {
    getByIdMock.mockResolvedValueOnce(null);
    const db = mockDb([]);
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/webhook-deliveries/retry`,
      payload: { issueId, agentId },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 403 when issue belongs to another company", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyB,
      assigneeAgentId: agentId,
      status: ISSUE_STATUS_TODO,
    });
    const db = mockDb([]);
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/webhook-deliveries/retry`,
      payload: { issueId, agentId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 422 when issue is not assigned to agent", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyA,
      assigneeAgentId: "other-agent-id",
      status: ISSUE_STATUS_TODO,
    });
    const db = mockDb([]);
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/webhook-deliveries/retry`,
      payload: { issueId, agentId },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("returns 422 when issue status is not workable", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: issueId,
      companyId: companyA,
      assigneeAgentId: agentId,
      status: ISSUE_STATUS_DONE,
    });
    const db = mockDb([]);
    const app = await createRouteTestFastify({
      plugin: (f) => webhookDeliveriesPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/webhook-deliveries/retry`,
      payload: { issueId, agentId },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
