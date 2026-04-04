import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { connectPlugin } from "../routes/connect.js";

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

const db = {} as unknown as Db;

describe("POST /api/companies/:companyId/connect", () => {
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

    const boardPrincipal: Principal = { type: "system", id: "board", roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => connectPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/connect`,
      payload: { toolName: "hive-cli", agentName: "cli-agent" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().agentId).toBe(agentId);
    expect(res.json().heartbeatUrl).toContain(`/api/agents/${agentId}/heartbeat/invoke`);
    expect(res.json().sseUrl).toContain(`/api/companies/${companyA}/events`);
    expect(res.json().workItems).toEqual({ tasks: [] });
    expect(res.json().apiKey).toBeUndefined();
    expect(mocks.createAgent).toHaveBeenCalledWith(companyA, expect.objectContaining({
      name: "cli-agent",
      role: "general",
      adapterType: "managed_worker",
      metadata: expect.objectContaining({ toolName: "hive-cli" }),
    }));
    expect(mocks.createApiKey).toHaveBeenCalledWith(agentId, "connect");
    await app.close();
  });

  it("returns 200 and no apiKey when agent already exists (idempotent by name)", async () => {
    mocks.resolveByReference.mockResolvedValue({ agent: mockAgent, ambiguous: false });

    const boardPrincipal: Principal = { type: "system", id: "board", roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => connectPlugin(f, { db }),
      principal: boardPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/connect`,
      payload: { toolName: "hive-cli", agentName: "cli-agent" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agentId).toBe(agentId);
    expect(res.json().workItems).toEqual({ tasks: [] });
    expect(res.json().apiKey).toBeUndefined();
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.createApiKey).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when agent actor calls connect (board-only)", async () => {
    const agentPrincipal: Principal = { type: "agent", id: "a1", company_id: companyA, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => connectPlugin(f, { db }),
      principal: agentPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyA}/connect`,
      payload: { toolName: "cli", agentName: "my-agent" },
    });
    expect(res.statusCode).toBe(403);
    expect(mocks.resolveByReference).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const agentPrincipal: Principal = { type: "agent", id: "a1", company_id: companyA, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => connectPlugin(f, { db }),
      principal: agentPrincipal,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/companies/${companyB}/connect`,
      payload: { toolName: "cli", agentName: "my-agent" },
    });
    expect(res.statusCode).toBe(403);
    expect(mocks.resolveByReference).not.toHaveBeenCalled();
    await app.close();
  });
});
