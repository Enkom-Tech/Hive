import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectRoutes } from "../routes/connect.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "660e8400-e29b-41d4-a716-446655440001";
const agentId = "880e8400-e29b-41d4-a716-446655440003";

const mockAgent = {
  id: agentId,
  companyId: companyA,
  name: "cli-agent",
  urlKey: "cli-agent",
  role: "general",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "managed_worker",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  permissions: {},
  lastHeartbeatAt: null,
  metadata: { toolName: "hive-cli", toolVersion: "1.0.0" },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mocks = vi.hoisted(() => ({
  resolveByReference: vi.fn(),
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  createApiKey: vi.fn(),
  listIssues: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    resolveByReference: mocks.resolveByReference,
    list: mocks.listAgents,
    create: mocks.createAgent,
    createApiKey: mocks.createApiKey,
  }),
  issueService: () => ({ list: mocks.listIssues }),
  logActivity: mocks.logActivity,
}));

function createApp(actor: {
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
        : {
            type: "agent",
            id: actor.agentId ?? "agent-1",
            company_id: actor.companyId ?? companyA,
            roles: [],
          };
    next();
  });
  app.use(connectRoutes({} as Parameters<typeof connectRoutes>[0]));
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/connect", () => {
  beforeEach(() => {
    mocks.resolveByReference.mockReset();
    mocks.listAgents.mockReset();
    mocks.createAgent.mockReset();
    mocks.createApiKey.mockReset();
    mocks.listIssues.mockReset();
    mocks.logActivity.mockReset();
    mocks.listIssues.mockResolvedValue([]);
  });

  it("returns 201 with agentId, URLs, workItems when creating new agent (no apiKey in response)", async () => {
    mocks.resolveByReference.mockResolvedValue({ agent: null, ambiguous: false });
    mocks.createAgent.mockResolvedValue(mockAgent);
    mocks.createApiKey.mockResolvedValue({ id: "key-1", name: "connect", token: "sk-secret-once", createdAt: new Date() });

    const app = createApp({ type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/connect`)
      .send({ toolName: "hive-cli", agentName: "cli-agent" });

    expect(res.status).toBe(201);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.heartbeatUrl).toContain(`/api/agents/${agentId}/heartbeat/invoke`);
    expect(res.body.sseUrl).toContain(`/api/companies/${companyA}/events`);
    expect(res.body.workItems).toEqual({ tasks: [] });
    expect(res.body.apiKey).toBeUndefined();
    expect(mocks.createAgent).toHaveBeenCalledWith(companyA, expect.objectContaining({
      name: "cli-agent",
      role: "general",
      adapterType: "managed_worker",
      metadata: expect.objectContaining({ toolName: "hive-cli" }),
    }));
    expect(mocks.createApiKey).toHaveBeenCalledWith(agentId, "connect");
  });

  it("returns 200 and no apiKey when agent already exists (idempotent by name)", async () => {
    mocks.resolveByReference.mockResolvedValue({ agent: mockAgent, ambiguous: false });

    const app = createApp({ type: "board" });
    const res = await request(app)
      .post(`/companies/${companyA}/connect`)
      .send({ toolName: "hive-cli", agentName: "cli-agent" });

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.workItems).toEqual({ tasks: [] });
    expect(res.body.apiKey).toBeUndefined();
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("returns 403 when agent actor calls connect (board-only)", async () => {
    const app = createApp({ type: "agent", agentId: "a1", companyId: companyA });
    const res = await request(app)
      .post(`/companies/${companyA}/connect`)
      .send({ toolName: "cli", agentName: "my-agent" });
    expect(res.status).toBe(403);
    expect(mocks.resolveByReference).not.toHaveBeenCalled();
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const app = createApp({ type: "agent", agentId: "a1", companyId: companyA });
    const res = await request(app)
      .post(`/companies/${companyB}/connect`)
      .send({ toolName: "cli", agentName: "my-agent" });
    expect(res.status).toBe(403);
    expect(mocks.resolveByReference).not.toHaveBeenCalled();
  });
});
