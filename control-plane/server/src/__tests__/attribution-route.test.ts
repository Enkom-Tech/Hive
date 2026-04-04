import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { agentsPlugin } from "../routes/agents/index.js";

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

const db = {} as unknown as Db;

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
    const principal: Principal = { type: "agent", id: agentA, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentA}/attribution` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      agentId: agentA,
      companyId,
      cost: expect.objectContaining({ spendCents: 500, budgetCents: 10000 }),
      activity: [],
      runs: [],
    });
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentA, limit: expect.any(Number) }),
    );
    await app.close();
  });

  it("returns 403 when agent calls /agents/:otherId/attribution", async () => {
    const principal: Principal = { type: "agent", id: agentA, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentB}/attribution` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("own attribution");
    await app.close();
  });

  it("returns 200 when board calls /agents/:id/attribution", async () => {
    const principal: Principal = {
      type: "user",
      id: "board",
      company_ids: [companyId],
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentA}/attribution` });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentId).toBe(agentA);
    expect(res.json().companyId).toBe(companyId);
    await app.close();
  });

  it("includes company comparison when board calls with privileged=1", async () => {
    const principal: Principal = {
      type: "user",
      id: "board",
      company_ids: [companyId],
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentA}/attribution?privileged=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().companySpendCents).toBe(1000);
    expect(res.json().companyBudgetCents).toBe(50000);
    await app.close();
  });

  it("respects activityLimit and runsLimit query params", async () => {
    const principal: Principal = {
      type: "user",
      id: "board",
      company_ids: [companyId],
      roles: ["instance_admin"],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal,
    });
    await app.inject({ method: "GET", url: `/api/agents/${agentA}/attribution?activityLimit=10&runsLimit=5` });
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
    expect(listHeartbeatMock).toHaveBeenCalledWith(companyId, agentA, 5);
    await app.close();
  });
});
