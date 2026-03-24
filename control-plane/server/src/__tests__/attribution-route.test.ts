import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents/index.js";
import { activityRoutes } from "../routes/activity.js";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";

const agentA = "aaaaaaaa-e29b-41d4-a716-446655440000";
const agentB = "bbbbbbbb-e29b-41d4-a716-446655440000";
const companyId = "550e8400-e29b-41d4-a716-446655440000";

const mockAgent = {
  id: agentA,
  companyId,
  name: "Agent A",
  role: "engineer",
  title: null,
  status: "active",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  contextMode: "thin",
  budgetMonthlyCents: 10000,
  spentMonthlyCents: 500,
  lastHeartbeatAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  urlKey: null,
  icon: null,
  permissions: null,
  runtimeConfig: null,
};

const mockAttributionPayload = {
  agentId: agentA,
  companyId,
  cost: { spendCents: 500, budgetCents: 10000, utilizationPercent: 5, period: undefined },
  activity: [],
  runs: [],
};

const listActivityMock = vi.fn();
const listHeartbeatMock = vi.fn();
const byAgentMock = vi.fn();

vi.mock("../services/index.js", () => ({
  activityService: () => ({ list: listActivityMock }),
  agentService: () => ({
    getById: vi.fn((id: string) =>
      id === agentA || id === agentB
        ? Promise.resolve({ ...mockAgent, id, companyId })
        : Promise.resolve(null),
    ),
    getChainOfCommand: vi.fn(() => Promise.resolve([])),
    list: vi.fn(() => Promise.resolve([])),
    orgForCompany: vi.fn(() => Promise.resolve([])),
    update: vi.fn(),
    listConfigRevisions: vi.fn(() => Promise.resolve([])),
    getConfigRevision: vi.fn(() => Promise.resolve(null)),
    rollbackConfigRevision: vi.fn(() => Promise.resolve(null)),
  }),
  accessService: () => ({
    canUser: vi.fn(() => Promise.resolve(true)),
    hasPermission: vi.fn(() => Promise.resolve(false)),
    isInstanceAdmin: vi.fn(() => Promise.resolve(false)),
  }),
  approvalService: vi.fn(() => ({ list: vi.fn(() => Promise.resolve([])) })),
  costService: () => ({
    byAgent: byAgentMock,
    summary: vi.fn(() =>
      Promise.resolve({ companyId, spendCents: 1000, budgetCents: 50000, utilizationPercent: 2 }),
    ),
  }),
  heartbeatService: () => ({
    list: listHeartbeatMock,
  }),
  issueApprovalService: vi.fn(() => ({})),
  issueService: vi.fn(() => ({ getById: vi.fn(), getByIdentifier: vi.fn() })),
  logActivity: vi.fn(),
  secretService: vi.fn(() => ({})),
}));

function createAgentApp(actor: {
  type: "board" | "agent";
  userId?: string;
  agentId?: string;
  companyId?: string;
  source?: string;
}) {
  const app = express();
  app.use((req, _res, next) => {
    req.principal =
      actor.type === "board"
        ? { type: "user", id: actor.userId ?? "board", company_ids: [companyId], roles: ["instance_admin"] }
        : { type: "agent", id: actor.agentId ?? agentA, company_id: actor.companyId ?? companyId, roles: [] };
    next();
  });
  app.use("/api", agentRoutes({} as any, { strictSecretsMode: false }));
  app.use(errorHandler);
  return app;
}

describe("GET /api/agents/:id/attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActivityMock.mockResolvedValue([]);
    listHeartbeatMock.mockResolvedValue([]);
    byAgentMock.mockResolvedValue([
      { agentId: agentA, agentName: "Agent A", agentStatus: "active", costCents: 500, inputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionOutputTokens: 0 },
    ]);
  });

  it("returns 200 and own data when agent calls /agents/:ownId/attribution", async () => {
    const app = createAgentApp({ type: "agent", agentId: agentA, companyId });
    const res = await request(app).get(`/api/agents/${agentA}/attribution`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agentId: agentA,
      companyId,
      cost: expect.objectContaining({ spendCents: 500, budgetCents: 10000 }),
      activity: [],
      runs: [],
    });
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentA, limit: expect.any(Number) }),
    );
  });

  it("returns 403 when agent calls /agents/:otherId/attribution", async () => {
    const app = createAgentApp({ type: "agent", agentId: agentA, companyId });
    const res = await request(app).get(`/api/agents/${agentB}/attribution`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("own attribution");
  });

  it("returns 200 when board calls /agents/:id/attribution", async () => {
    const app = createAgentApp({ type: "board" });
    const res = await request(app).get(`/api/agents/${agentA}/attribution`);
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agentA);
    expect(res.body.companyId).toBe(companyId);
  });

  it("includes company comparison when board calls with privileged=1", async () => {
    const app = createAgentApp({ type: "board" });
    const res = await request(app).get(`/api/agents/${agentA}/attribution?privileged=1`);
    expect(res.status).toBe(200);
    expect(res.body.companySpendCents).toBe(1000);
    expect(res.body.companyBudgetCents).toBe(50000);
  });

  it("respects activityLimit and runsLimit query params", async () => {
    const app = createAgentApp({ type: "board" });
    await request(app).get(`/api/agents/${agentA}/attribution?activityLimit=10&runsLimit=5`);
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
    expect(listHeartbeatMock).toHaveBeenCalledWith(companyId, agentA, 5);
  });
});
