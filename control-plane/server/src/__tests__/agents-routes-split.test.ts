import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents/index.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "550e8400-e29b-41d4-a716-446655440000";
const agentId = "aaaaaaaa-e29b-41d4-a716-446655440000";

const mockDb = {} as import("@hive/db").Db;

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

function createApp(actor: { type: "board" | "agent" | "none"; userId?: string; agentId?: string; companyId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor.type === "none") {
      req.principal = null;
    } else if (actor.type === "board") {
      req.principal = {
        type: "system",
        id: actor.userId ?? "user-1",
        roles: ["instance_admin"],
      };
    } else {
      req.principal = {
        type: "agent",
        id: actor.agentId ?? agentId,
        company_id: actor.companyId ?? companyId,
        roles: [],
      };
    }
    next();
  });
  app.use("/api", agentRoutes(mockDb, { strictSecretsMode: false }));
  app.use(errorHandler);
  return app;
}

describe("agents keys routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/agents/:id/keys returns 403 when actor is agent (board required)", async () => {
    const app = createApp({ type: "agent" });
    await request(app)
      .get(`/api/agents/${agentId}/keys`)
      .expect(403);
  });
});

describe("GET /api/companies/:companyId/drones/overview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with boardAgents when board has access", async () => {
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/api/companies/${companyId}/drones/overview`);
    expect(res.status).toBe(200);
    expect(res.body.instances).toEqual([]);
    expect(res.body.unassignedBoardAgents).toHaveLength(1);
    expect(res.body.boardAgents).toHaveLength(1);
    expect(res.body.boardAgents[0].agentId).toBe(agentId);
    expect(res.body.boardAgents[0].name).toBe("COO");
    expect(res.body.boardAgents[0].connected).toBe(false);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createApp({ type: "none" });
    await request(app).get(`/api/companies/${companyId}/drones/overview`).expect(401);
  });

  it("returns 403 when user agent accesses another company", async () => {
    const otherCo = "650e8400-e29b-41d4-a716-446655440001";
    const app = createApp({ type: "agent", companyId });
    await request(app).get(`/api/companies/${otherCo}/drones/overview`).expect(403);
  });

  it("returns 404 for removed workers/overview path (no backward compatibility)", async () => {
    const app = createApp({ type: "board" });
    const legacy = `/api/companies/${companyId}/workers/overview`;
    await request(app).get(legacy).expect(404);
  });
});

describe("GET /api/agents/:id/worker-connection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 and connected false when no worker is linked", async () => {
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/api/agents/${agentId}/worker-connection`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
  });

  it("returns 404 when agent does not exist", async () => {
    const app = createApp({ type: "board" });
    const missingId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const res = await request(app).get(`/api/agents/${missingId}/worker-connection`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/agents/:id/link-enrollment-tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with token when board mints enrollment", async () => {
    const app = createApp({ type: "board" });
    const res = await request(app).post(`/api/agents/${agentId}/link-enrollment-tokens`).send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toBe("hive_wen_testtoken");
    expect(res.body.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("returns 403 when actor is agent", async () => {
    const app = createApp({ type: "agent" });
    await request(app).post(`/api/agents/${agentId}/link-enrollment-tokens`).send({}).expect(403);
  });

  it("returns 404 for removed worker-enrollment-tokens path (no backward compatibility)", async () => {
    const app = createApp({ type: "board" });
    const legacy = `/api/agents/${agentId}/worker-enrollment-tokens`;
    await request(app).post(legacy).send({}).expect(404);
  });
});

describe("agents runs routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/companies/:companyId/heartbeat-runs returns 401 with no auth", async () => {
    const app = createApp({ type: "none" });
    await request(app)
      .get(`/api/companies/${companyId}/heartbeat-runs`)
      .expect(401);
  });
});
