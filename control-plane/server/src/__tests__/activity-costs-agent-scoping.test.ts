import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../routes/activity.js";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";

const agentA = "aaaaaaaa-e29b-41d4-a716-446655440000";
const agentB = "bbbbbbbb-e29b-41d4-a716-446655440000";
const companyId = "550e8400-e29b-41d4-a716-446655440000";

const listActivityMock = vi.fn();
const byAgentMock = vi.fn();

vi.mock("../services/activity.js", () => ({
  activityService: () => ({
    list: listActivityMock,
    forIssue: vi.fn(),
    runsForIssue: vi.fn(),
    issuesForRun: vi.fn(),
    create: vi.fn(),
  }),
}));

vi.mock("../services/index.js", () => ({
  activityService: () => ({ list: listActivityMock }),
  costService: () => ({
    byAgent: byAgentMock,
    summary: vi.fn(() =>
      Promise.resolve({ companyId, spendCents: 0, budgetCents: 0, utilizationPercent: 0 }),
    ),
    series: vi.fn(() => Promise.resolve([])),
    byProject: vi.fn(() => Promise.resolve([])),
    byModel: vi.fn(() => Promise.resolve([])),
  }),
  companyService: () => ({ update: vi.fn(() => Promise.resolve(null)) }),
  agentService: () => ({
    getById: vi.fn((id: string) =>
      [agentA, agentB].includes(id)
        ? Promise.resolve({ id, companyId, budgetMonthlyCents: 0 })
        : Promise.resolve(null),
    ),
    update: vi.fn((id: string, data: { budgetMonthlyCents: number }) =>
      Promise.resolve({ id, companyId, budgetMonthlyCents: data.budgetMonthlyCents }),
    ),
  }),
  issueService: vi.fn(() => ({ getById: vi.fn(() => null), getByIdentifier: vi.fn(() => null) })),
  logActivity: vi.fn(),
}));

function createActivityApp(actor: { type: "board" | "agent"; agentId?: string; companyId?: string }) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).principal =
      actor.type === "board"
        ? { type: "system", id: "board", roles: ["instance_admin"] }
        : { type: "agent", id: actor.agentId ?? agentA, company_id: actor.companyId ?? companyId, roles: [] };
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function createCostsApp(actor: { type: "board" | "agent"; agentId?: string; companyId?: string }) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).principal =
      actor.type === "board"
        ? { type: "system", id: "board", roles: ["instance_admin"] }
        : { type: "agent", id: actor.agentId ?? agentA, company_id: actor.companyId ?? companyId, roles: [] };
    next();
  });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/activity (agent self-scoping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActivityMock.mockResolvedValue([]);
  });

  it("forces agentId to authenticated agent when caller is agent", async () => {
    const app = createActivityApp({ type: "agent", agentId: agentA, companyId });
    await request(app).get(`/api/companies/${companyId}/activity`);
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentA }),
    );
  });

  it("ignores query agentId when caller is agent and uses own agentId", async () => {
    const app = createActivityApp({ type: "agent", agentId: agentA, companyId });
    await request(app).get(`/api/companies/${companyId}/activity?agentId=${agentB}`);
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentA }),
    );
  });

  it("allows board to pass agentId filter", async () => {
    const app = createActivityApp({ type: "board" });
    await request(app).get(`/api/companies/${companyId}/activity?agentId=${agentB}`);
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentB }),
    );
  });
});

describe("GET /companies/:companyId/costs/by-agent (agent self-scoping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    byAgentMock.mockResolvedValue([
      { agentId: agentA, agentName: "A", agentStatus: "active", costCents: 100, inputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionOutputTokens: 0 },
      { agentId: agentB, agentName: "B", agentStatus: "active", costCents: 200, inputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionOutputTokens: 0 },
    ]);
  });

  it("returns only the calling agent row when caller is agent", async () => {
    const app = createCostsApp({ type: "agent", agentId: agentA, companyId });
    const res = await request(app).get(`/api/companies/${companyId}/costs/by-agent`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agentId).toBe(agentA);
    expect(res.body[0].costCents).toBe(100);
  });

  it("returns all rows when caller is board", async () => {
    const app = createCostsApp({ type: "board" });
    const res = await request(app).get(`/api/companies/${companyId}/costs/by-agent`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
