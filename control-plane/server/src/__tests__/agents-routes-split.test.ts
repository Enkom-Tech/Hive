import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { agentsPlugin } from "../routes/agents/index.js";

const companyId = "550e8400-e29b-41d4-a716-446655440000";
const agentId = "aaaaaaaa-e29b-41d4-a716-446655440000";

const db = {} as Db;

vi.mock("../services/index.js", () => ({
  activityService: () => ({ list: vi.fn(() => Promise.resolve([])) }),
  agentService: () => ({
    getById: vi.fn((id: string) =>
      id === agentId ? Promise.resolve({ id, companyId, name: "A", role: "engineer" }) : Promise.resolve(null),
    ),
    getChainOfCommand: vi.fn(() => Promise.resolve([])),
    list: vi.fn(() => Promise.resolve([])),
    listDroneBoardAgentOverview: vi.fn(() =>
      Promise.resolve({
        instances: [],
        unassignedBoardAgents: [
          {
            agentId,
            name: "COO",
            urlKey: "coo",
            status: "idle",
            connected: false,
            lastHeartbeatAt: null,
            pendingEnrollmentCount: 0,
            drone: null,
            workerInstanceId: null,
          },
        ],
        boardAgents: [
          {
            agentId,
            name: "COO",
            urlKey: "coo",
            status: "idle",
            connected: false,
            lastHeartbeatAt: null,
            pendingEnrollmentCount: 0,
            drone: null,
            workerInstanceId: null,
          },
        ],
      }),
    ),
    listKeys: vi.fn(() => Promise.resolve([])),
    createApiKey: vi.fn(),
    revokeKey: vi.fn(() => Promise.resolve(null)),
    createLinkEnrollmentToken: vi.fn(() =>
      Promise.resolve({
        token: "hive_wen_testtoken",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
    ),
    orgForCompany: vi.fn(() => Promise.resolve([])),
    listConfigRevisions: vi.fn(() => Promise.resolve([])),
    getConfigRevision: vi.fn(() => Promise.resolve(null)),
    rollbackConfigRevision: vi.fn(() => Promise.resolve(null)),
    resolveByReference: vi.fn(() => Promise.resolve({ agent: null, ambiguous: false })),
  }),
  accessService: () => ({
    canUser: vi.fn(() => Promise.resolve(true)),
    hasPermission: vi.fn(() => Promise.resolve(false)),
  }),
  approvalService: vi.fn(() => ({})),
  costService: () => ({
    byAgent: vi.fn(() => Promise.resolve([])),
    summary: vi.fn(() => Promise.resolve({ spendCents: 0, budgetCents: 0 })),
  }),
  heartbeatService: () => ({
    list: vi.fn(() => Promise.resolve([])),
    getRun: vi.fn(() => Promise.resolve(null)),
    getRuntimeState: vi.fn(() => Promise.resolve(null)),
    listTaskSessions: vi.fn(() => Promise.resolve([])),
  }),
  issueApprovalService: vi.fn(() => ({})),
  issueService: () => ({ list: vi.fn(() => Promise.resolve({ tasks: [] })), getById: vi.fn(), getByIdentifier: vi.fn() }),
  logActivity: vi.fn(() => Promise.resolve()),
  secretService: vi.fn(() => ({})),
}));

describe("agents keys routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/agents/:id/keys returns 403 when actor is agent (board required)", async () => {
    const principal: Principal = { type: "agent", id: agentId, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}/keys` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/companies/:companyId/drones/overview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with boardAgents when board has access", async () => {
    const principal: Principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyId}/drones/overview` });
    expect(res.statusCode).toBe(200);
    expect(res.json().instances).toEqual([]);
    expect(res.json().unassignedBoardAgents).toHaveLength(1);
    expect(res.json().boardAgents).toHaveLength(1);
    expect(res.json().boardAgents[0].agentId).toBe(agentId);
    expect(res.json().boardAgents[0].name).toBe("COO");
    expect(res.json().boardAgents[0].connected).toBe(false);
    await app.close();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal: null,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyId}/drones/overview` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 403 when user agent accesses another company", async () => {
    const otherCo = "650e8400-e29b-41d4-a716-446655440001";
    const principal: Principal = { type: "agent", id: agentId, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${otherCo}/drones/overview` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 for removed workers/overview path (no backward compatibility)", async () => {
    const principal: Principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const legacy = `/api/companies/${companyId}/workers/overview`;
    const res = await app.inject({ method: "GET", url: legacy });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /api/agents/:id/worker-connection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 and connected false when no worker is linked", async () => {
    const principal: Principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentId}/worker-connection` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false });
    await app.close();
  });

  it("returns 404 when agent does not exist", async () => {
    const principal: Principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const missingId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const res = await app.inject({ method: "GET", url: `/api/agents/${missingId}/worker-connection` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/agents/:id/link-enrollment-tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with token when board mints enrollment", async () => {
    const principal: Principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/link-enrollment-tokens`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBe("hive_wen_testtoken");
    expect(res.json().expiresAt).toBe("2099-01-01T00:00:00.000Z");
    await app.close();
  });

  it("returns 403 when actor is agent", async () => {
    const principal: Principal = { type: "agent", id: agentId, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/link-enrollment-tokens`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 for removed worker-enrollment-tokens path (no backward compatibility)", async () => {
    const principal: Principal = {
      type: "system",
      id: "user-1",
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const legacy = `/api/agents/${agentId}/worker-enrollment-tokens`;
    const res = await app.inject({ method: "POST", url: legacy, payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("agents runs routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/companies/:companyId/heartbeat-runs returns 401 with no auth", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal: null,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyId}/heartbeat-runs` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
