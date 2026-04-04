import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { activityPlugin } from "../routes/activity.js";
import { costsPlugin } from "../routes/costs.js";

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

const db = {} as unknown as Db;

describe("GET /api/companies/:companyId/activity (agent self-scoping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActivityMock.mockResolvedValue([]);
  });

  it("forces agentId to authenticated agent when caller is agent", async () => {
    const principal: Principal = { type: "agent", id: agentA, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => activityPlugin(f, { db }),
      principal,
    });
    await app.inject({ method: "GET", url: `/api/companies/${companyId}/activity` });
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentA }),
    );
    await app.close();
  });

  it("ignores query agentId when caller is agent and uses own agentId", async () => {
    const principal: Principal = { type: "agent", id: agentA, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => activityPlugin(f, { db }),
      principal,
    });
    await app.inject({ method: "GET", url: `/api/companies/${companyId}/activity?agentId=${agentB}` });
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentA }),
    );
    await app.close();
  });

  it("allows board to pass agentId filter", async () => {
    const principal: Principal = { type: "system", id: "board", roles: ["instance_admin"] };
    const app = await createRouteTestFastify({
      plugin: (f) => activityPlugin(f, { db }),
      principal,
    });
    await app.inject({ method: "GET", url: `/api/companies/${companyId}/activity?agentId=${agentB}` });
    expect(listActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, agentId: agentB }),
    );
    await app.close();
  });
});

describe("GET /api/companies/:companyId/costs/by-agent (agent self-scoping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    byAgentMock.mockResolvedValue([
      { agentId: agentA, agentName: "A", agentStatus: "active", costCents: 100, inputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionOutputTokens: 0 },
      { agentId: agentB, agentName: "B", agentStatus: "active", costCents: 200, inputTokens: 0, outputTokens: 0, apiRunCount: 0, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionOutputTokens: 0 },
    ]);
  });

  it("returns only the calling agent row when caller is agent", async () => {
    const principal: Principal = { type: "agent", id: agentA, company_id: companyId, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => costsPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyId}/costs/by-agent` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].agentId).toBe(agentA);
    expect(res.json()[0].costCents).toBe(100);
    await app.close();
  });

  it("returns all rows when caller is board", async () => {
    const principal: Principal = { type: "system", id: "board", roles: ["instance_admin"] };
    const app = await createRouteTestFastify({
      plugin: (f) => costsPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyId}/costs/by-agent` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    await app.close();
  });
});
