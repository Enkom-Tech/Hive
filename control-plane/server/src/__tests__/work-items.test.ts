import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { ISSUE_STATUS_TODO } from "@hive/shared";
import { setRunLogBasePath } from "../services/run-log-store.js";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { agentsPlugin } from "../routes/agents/index.js";

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const agentA = "880e8400-e29b-41d4-a716-446655440003";
const agentB = "990e8400-e29b-41d4-a716-446655440004";

const mockAgentA = {
  id: agentA,
  companyId: companyA,
  name: "Agent A",
  urlKey: "agent-a",
  role: "general",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  permissions: {},
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockAgentB = {
  ...mockAgentA,
  id: agentB,
  name: "Agent B",
  urlKey: "agent-b",
};

const mockTasks = [
  {
    id: "issue-1",
    companyId: companyA,
    title: "Task one",
    status: ISSUE_STATUS_TODO,
    assigneeAgentId: agentA,
    assigneeUserId: null,
  },
];

const getByIdMock = vi.fn();
const listIssuesMock = vi.fn();

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    agentService: () => ({ getById: getByIdMock }),
    issueService: () => ({ list: listIssuesMock }),
  };
});

const db = {} as unknown as Db;

describe("GET /api/agents/:id/work-items", () => {
  beforeEach(() => {
    setRunLogBasePath(path.join(os.tmpdir(), "hive-work-items-test-run-logs"));
    getByIdMock.mockReset();
    listIssuesMock.mockReset();
  });

  it("returns 200 with tasks when board requests work-items for an agent", async () => {
    getByIdMock.mockResolvedValue(mockAgentA);
    listIssuesMock.mockResolvedValue(mockTasks);

    const boardPrincipal: Principal = { type: "system", id: "board", roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal: boardPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentA}/work-items` });

    expect(res.statusCode).toBe(200);
    expect(res.json().tasks).toHaveLength(1);
    expect(res.json().tasks[0].id).toBe("issue-1");
    expect(res.json().tasks[0].assigneeAgentId).toBe(agentA);
    expect(listIssuesMock).toHaveBeenCalledWith(companyA, {
      assigneeAgentId: agentA,
      status: "todo,in_progress",
    });
    await app.close();
  });

  it("returns 200 when agent requests own work-items", async () => {
    getByIdMock.mockResolvedValue(mockAgentA);
    listIssuesMock.mockResolvedValue(mockTasks);

    const agentPrincipal: Principal = { type: "agent", id: agentA, company_id: companyA, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal: agentPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentA}/work-items` });

    expect(res.statusCode).toBe(200);
    expect(res.json().tasks).toHaveLength(1);
    await app.close();
  });

  it("returns 403 when agent requests another agent work-items", async () => {
    getByIdMock.mockResolvedValue(mockAgentB);

    const agentPrincipal: Principal = { type: "agent", id: agentA, company_id: companyA, roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal: agentPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentB}/work-items` });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("own work-items");
    expect(listIssuesMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 when agent does not exist", async () => {
    getByIdMock.mockResolvedValue(null);

    const boardPrincipal: Principal = { type: "system", id: "board", roles: [] };
    const app = await createRouteTestFastify({
      plugin: (f) => agentsPlugin(f, { db, strictSecretsMode: false }),
      principal: boardPrincipal,
    });
    const res = await app.inject({ method: "GET", url: `/api/agents/${agentA}/work-items` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Agent not found");
    await app.close();
  });
});
