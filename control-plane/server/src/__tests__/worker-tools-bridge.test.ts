import { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workerToolRoutes, WORKER_TOOL_BRIDGE_ACTIONS } from "../routes/worker-tools.js";
import { createRouteTestApp, principalAgent, principalBoard } from "./helpers/route-app.js";

const mockDb = {} as import("@hive/db").Db;
const companyA = "550e8400-e29b-41d4-a716-446655440000";
const agentId = "bbbbbbbb-e29b-41d4-a716-4466554400aa";
const issueUuid = "cccccccc-e29b-41d4-a716-4466554400bb";

const createEvent = vi.fn(() => Promise.resolve({ id: "cost-event-1" }));
const getById = vi.fn();
const getByIdentifier = vi.fn();
const assertCheckoutOwner = vi.fn(() => Promise.resolve({ adoptedFromRunId: null }));
const addComment = vi.fn(() => Promise.resolve({ id: "comment-1", body: "x" }));
const updateIssue = vi.fn(() =>
  Promise.resolve({ id: issueUuid, companyId: companyA, status: "in_review" }),
);

vi.mock("../services/index.js", () => ({
  costService: () => ({ createEvent }),
  issueService: () => ({
    getById,
    getByIdentifier,
    assertCheckoutOwner,
    addComment,
    update: updateIssue,
  }),
  logActivity: vi.fn(() => Promise.resolve()),
}));

function apiRouter(allowedActions: string[]) {
  const r = Router();
  r.use("/worker-tools", workerToolRoutes(mockDb, { allowedActions }));
  return r;
}

describe("worker tool bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getById.mockResolvedValue(null);
    getByIdentifier.mockResolvedValue(null);
    updateIssue.mockResolvedValue({ id: issueUuid, companyId: companyA, status: "in_review" });
  });

  it("returns 403 for board principal", async () => {
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.costReport]),
      principal: principalBoard({ companyIds: [companyA] }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({ action: WORKER_TOOL_BRIDGE_ACTIONS.costReport, input: {} })
      .expect(403);
  });

  it("returns 503 when bridge allowlist is empty", async () => {
    const app = createRouteTestApp({
      router: apiRouter([]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({ action: WORKER_TOOL_BRIDGE_ACTIONS.costReport, input: {} })
      .expect(503);
  });

  it("returns 403 when action is not allowlisted", async () => {
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.costReport]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({ action: "hire.request", input: {} })
      .expect(403);
  });

  it("cost.report creates event scoped to agent", async () => {
    const occurredAt = new Date().toISOString();
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.costReport]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    const res = await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.costReport,
        input: {
          provider: "openai",
          model: "gpt-4",
          costCents: 12,
          occurredAt,
        },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.costEventId).toBe("cost-event-1");
    expect(createEvent).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({
        agentId,
        provider: "openai",
        model: "gpt-4",
        costCents: 12,
      }),
    );
  });

  it("issue.appendComment resolves identifier and skips checkout when not in progress", async () => {
    getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "todo",
      assigneeAgentId: null,
    });
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.issueAppendComment]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.issueAppendComment,
        input: { issueId: issueUuid, body: "hello" },
      })
      .expect(200);
    expect(assertCheckoutOwner).not.toHaveBeenCalled();
    expect(addComment).toHaveBeenCalledWith(issueUuid, "hello", { agentId });
  });

  it("issue.transitionStatus updates when agent is assignee", async () => {
    getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "todo",
      assigneeAgentId: agentId,
    });
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus,
        input: { issueId: issueUuid, status: "in_progress" },
      })
      .expect(200);
    expect(updateIssue).toHaveBeenCalledWith(issueUuid, { status: "in_progress" });
  });

  it("issue.transitionStatus allows in_progress when run id present", async () => {
    getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus]),
      principal: principalAgent({ agentId, companyId: companyA, runId: "run-1" }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus,
        input: { issueId: issueUuid, status: "in_review" },
      })
      .expect(200);
    expect(assertCheckoutOwner).toHaveBeenCalled();
  });

  it("issue.transitionStatus requires run id when checked out to agent", async () => {
    getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.issueTransitionStatus,
        input: { issueId: issueUuid, status: "in_review" },
      })
      .expect(401);
  });

  it("issue.get returns summary for issue in company", async () => {
    getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      identifier: "TST-1",
      title: "Hello",
      status: "todo",
      assigneeAgentId: null,
      projectId: null,
    });
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.issueGet]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    const res = await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.issueGet,
        input: { issueId: issueUuid },
      })
      .expect(200);
    expect(res.body.result.identifier).toBe("TST-1");
    expect(res.body.result.title).toBe("Hello");
  });

  it("issue.appendComment requires run id when checked out to agent", async () => {
    getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const app = createRouteTestApp({
      router: apiRouter([WORKER_TOOL_BRIDGE_ACTIONS.issueAppendComment]),
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    await request(app)
      .post("/api/worker-tools/bridge")
      .send({
        action: WORKER_TOOL_BRIDGE_ACTIONS.issueAppendComment,
        input: { issueId: issueUuid, body: "hello" },
      })
      .expect(401);
  });
});
