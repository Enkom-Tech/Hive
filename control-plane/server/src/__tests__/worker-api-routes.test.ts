import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import {
  initPlacementPrometheus,
  renderPlacementPrometheusScrape,
  resetPrometheusRegistryForTests,
} from "../placement-metrics.js";
import { forbidden } from "../errors.js";
import { workerApiPlugin } from "../routes/worker-api/index.js";
import {
  createRouteTestFastify,
  principalAgent,
  principalBoard,
  principalWorkerInstance,
} from "./helpers/route-app.js";

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "660e8400-e29b-41d4-a716-446655440001";
const agentId = "bbbbbbbb-e29b-41d4-a716-4466554400aa";
const workerInstId = "77777777-e29b-41d4-a716-446655440077";
const issueUuid = "cccccccc-e29b-41d4-a716-4466554400bb";

const svcMocks = vi.hoisted(() => {
  const cid = "550e8400-e29b-41d4-a716-446655440000";
  const iid = "cccccccc-e29b-41d4-a716-4466554400bb";
  const createEvent = vi.fn(() => Promise.resolve({ id: "cost-event-1" }));
  const getById = vi.fn();
  const getByIdentifier = vi.fn();
  const assertCheckoutOwner = vi.fn(() => Promise.resolve({ adoptedFromRunId: null }));
  const addComment = vi.fn(() => Promise.resolve({ id: "comment-1", body: "x" }));
  const updateIssue = vi.fn(() =>
    Promise.resolve({
      id: iid,
      companyId: cid,
      status: "in_review",
      assigneeAgentId: null,
    }),
  );
  const validateIssueCreateAssignees = vi.fn(() => Promise.resolve());
  const createInTx = vi.fn(() =>
    Promise.resolve({
      id: iid,
      companyId: cid,
      title: "New issue",
      identifier: "TST-1",
      status: "backlog",
      assigneeAgentId: null,
    }),
  );
  const createOrFoldIntent = vi.fn(() =>
    Promise.resolve({
      intentId: "11111111-e29b-41d4-a716-446655440001",
      canonicalKey: "k",
      folded: false,
    }),
  );
  const insertIntentLink = vi.fn(() => Promise.resolve());
  const deliverWorkAvailable = vi.fn(() => Promise.resolve());
  const publishLiveEvent = vi.fn();
  const logActivity = vi.fn(() => Promise.resolve());
  const wakeup = vi.fn(() => Promise.resolve());
  const finishRunForIssueClosure = vi.fn(() => Promise.resolve(null));
  return {
    createEvent,
    getById,
    getByIdentifier,
    assertCheckoutOwner,
    addComment,
    updateIssue,
    validateIssueCreateAssignees,
    createInTx,
    createOrFoldIntent,
    insertIntentLink,
    deliverWorkAvailable,
    publishLiveEvent,
    logActivity,
    wakeup,
    finishRunForIssueClosure,
  };
});

const issueHelperMocks = vi.hoisted(() => ({
  assertWorkerAgentCanAssignTasks: vi.fn(() => Promise.resolve()),
  assertWorkerAgentCanCreateAgents: vi.fn(() => Promise.resolve()),
  assertWorkerIssueDepartmentConstraints: vi.fn(() => Promise.resolve()),
}));

vi.mock("../routes/worker-api-issue-helpers.js", () => issueHelperMocks);

const hireMocks = vi.hoisted(() => ({
  runWorkerApiAgentHire: vi.fn(() =>
    Promise.resolve({
      agent: { id: "aaaaaaaa-e29b-41d4-a716-4466554400dd" },
      approval: null,
    }),
  ),
}));

vi.mock("../routes/worker-api-agent-hire.js", () => ({
  runWorkerApiAgentHire: hireMocks.runWorkerApiAgentHire,
}));

vi.mock("../services/index.js", () => ({
  costService: () => ({ createEvent: svcMocks.createEvent }),
  issueService: () => ({
    getById: svcMocks.getById,
    getByIdentifier: svcMocks.getByIdentifier,
    assertCheckoutOwner: svcMocks.assertCheckoutOwner,
    addComment: svcMocks.addComment,
    update: svcMocks.updateIssue,
    validateIssueCreateAssignees: svcMocks.validateIssueCreateAssignees,
    createInTx: svcMocks.createInTx,
  }),
  heartbeatService: () => ({
    wakeup: svcMocks.wakeup,
    finishRunForIssueClosure: svcMocks.finishRunForIssueClosure,
  }),
  logActivity: svcMocks.logActivity,
  createOrFoldIntent: svcMocks.createOrFoldIntent,
  insertIntentLink: svcMocks.insertIntentLink,
  deliverWorkAvailable: svcMocks.deliverWorkAvailable,
  publishLiveEvent: svcMocks.publishLiveEvent,
  WORKABLE_STATUSES_FOR_WEBHOOK: ["todo", "in_progress"],
}));

function mockDbWithAgent(agentRow: { id: string; status: string } | null): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(agentRow ? [agentRow] : []),
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
  } as unknown as Db;
}

function mockDbIssueCreateWithIdempotency(opts: {
  agentRow: { id: string; status: string } | null;
  idempotencyCached: { httpStatus: number; responseBody: unknown } | null;
}): Db {
  const tx = {
    execute: vi.fn(() => Promise.resolve()),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(opts.idempotencyCached ? [opts.idempotencyCached] : [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  };
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(opts.agentRow ? [opts.agentRow] : []),
      }),
    }),
    transaction: async <T>(fn: (inner: unknown) => Promise<T>) => fn(tx),
  } as unknown as Db;
}

describe("worker-api routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svcMocks.getById.mockResolvedValue(null);
    svcMocks.getByIdentifier.mockResolvedValue(null);
    svcMocks.updateIssue.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_review",
      assigneeAgentId: null,
    });
  });

  it("returns 403 for board principal on cost-report", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalBoard({ companyIds: [companyA] }),
    });
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/cost-report",
      payload: { agentId, provider: "openai", model: "gpt-4o", costCents: 1, occurredAt },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 403 for agent principal on cost-report", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalAgent({ agentId, companyId: companyA }),
    });
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/cost-report",
      payload: { agentId, provider: "openai", model: "gpt-4o", costCents: 1, occurredAt },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 201 for worker_instance principal when agent is in company", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/cost-report",
      payload: { agentId, provider: "openai", model: "gpt-4o", costCents: 42, occurredAt },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(res.json().result.costEventId).toBe("cost-event-1");
    expect(svcMocks.createEvent).toHaveBeenCalledWith(
      companyA,
      expect.objectContaining({ agentId, provider: "openai", model: "gpt-4o", costCents: 42 }),
    );
    await app.close();
  });

  it("returns 403 when agentId is not in worker company", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent(null), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/cost-report",
      payload: { agentId, provider: "openai", model: "gpt-4o", costCents: 1, occurredAt },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 403 for terminated agent on cost-report", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "terminated" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const occurredAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/cost-report",
      payload: { agentId, provider: "openai", model: "gpt-4o", costCents: 1, occurredAt },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 403 when issue belongs to another company", async () => {
    svcMocks.getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyB,
      status: "todo",
      assigneeAgentId: null,
    });
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/worker-api/issues/${issueUuid}/comments`,
      payload: { agentId, body: "x" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 401 for in_progress checkout comment without x-hive-run-id", async () => {
    svcMocks.getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/worker-api/issues/${issueUuid}/comments`,
      payload: { agentId, body: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("issue.appendComment via worker_instance", async () => {
    svcMocks.getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "todo",
      assigneeAgentId: null,
    });
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/worker-api/issues/${issueUuid}/comments`,
      payload: { agentId, body: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.commentId).toBe("comment-1");
    expect(svcMocks.addComment).toHaveBeenCalled();
    await app.close();
  });

  it("POST /issues creates issue via worker_instance", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/issues",
      payload: { agentId, title: "From worker" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(res.json().result.issue.identifier).toBe("TST-1");
    expect(svcMocks.createOrFoldIntent).toHaveBeenCalled();
    expect(svcMocks.createInTx).toHaveBeenCalled();
    expect(svcMocks.insertIntentLink).toHaveBeenCalled();
    await app.close();
  });

  it("POST /issues rejects empty X-Hive-Worker-Idempotency-Key", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/issues",
      headers: { "X-Hive-Worker-Idempotency-Key": "   " },
      payload: { agentId, title: "From worker" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /issues idempotency replay skips create and side effects", async () => {
    const cachedBody = {
      ok: true,
      result: { issue: { id: issueUuid, identifier: "REPLAY-9", title: "cached" } },
    };
    const app = await createRouteTestFastify({
      plugin: (f) =>
        workerApiPlugin(f, {
          db: mockDbIssueCreateWithIdempotency({
            agentRow: { id: agentId, status: "active" },
            idempotencyCached: { httpStatus: 201, responseBody: cachedBody },
          }),
          secretsStrictMode: false,
        }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/issues",
      headers: { "X-Hive-Worker-Idempotency-Key": "key-replay-1" },
      payload: { agentId, title: "From worker" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(cachedBody);
    expect(svcMocks.createInTx).not.toHaveBeenCalled();
    expect(svcMocks.logActivity).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /issues idempotency miss runs create flow", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) =>
        workerApiPlugin(f, {
          db: mockDbIssueCreateWithIdempotency({
            agentRow: { id: agentId, status: "active" },
            idempotencyCached: null,
          }),
          secretsStrictMode: false,
        }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/issues",
      headers: { "X-Hive-Worker-Idempotency-Key": "key-fresh-1" },
      payload: { agentId, title: "From worker" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(res.json().result.issue.identifier).toBe("TST-1");
    expect(svcMocks.createInTx).toHaveBeenCalled();
    expect(svcMocks.logActivity).toHaveBeenCalled();
    await app.close();
  });

  it("POST /agent-hires returns 201 for worker_instance", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/agent-hires",
      payload: { agentId, name: "New hire" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(res.json().result.agent.id).toBe("aaaaaaaa-e29b-41d4-a716-4466554400dd");
    await app.close();
  });

  it("POST /agent-hires returns 403 when acting agent lacks agents:create", async () => {
    issueHelperMocks.assertWorkerAgentCanCreateAgents.mockRejectedValueOnce(
      forbidden("Missing permission: can create agents"),
    );
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/agent-hires",
      payload: { agentId, name: "x" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /agent-hires returns 201 with approval when company requires board approval", async () => {
    hireMocks.runWorkerApiAgentHire.mockResolvedValueOnce({
      agent: { id: "bbbbbbbb-e29b-41d4-a716-4466554400ee", status: "pending_approval" },
      approval: { id: "cccccccc-e29b-41d4-a716-4466554400ff", status: "pending" },
    });
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/worker-api/agent-hires",
      payload: { agentId, name: "Needs approval" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().result.approval?.id).toBe("cccccccc-e29b-41d4-a716-4466554400ff");
    expect(res.json().result.agent.status).toBe("pending_approval");
    await app.close();
  });

  it("PATCH /issues/:id returns 200 for worker_instance", async () => {
    svcMocks.getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "todo",
      assigneeAgentId: null,
      createdByUserId: null,
    });
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/worker-api/issues/${issueUuid}`,
      payload: { agentId, title: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(svcMocks.updateIssue).toHaveBeenCalled();
    await app.close();
  });
});

describe("worker-api prometheus metrics", () => {
  beforeEach(() => {
    resetPrometheusRegistryForTests();
    initPlacementPrometheus(true);
    vi.clearAllMocks();
    svcMocks.getById.mockResolvedValue(null);
    svcMocks.getByIdentifier.mockResolvedValue(null);
    svcMocks.updateIssue.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_review",
      assigneeAgentId: null,
    });
  });

  it("records 2xx for successful cost-report", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    const occurredAt = new Date().toISOString();
    await app.inject({
      method: "POST",
      url: "/api/worker-api/cost-report",
      payload: { agentId, provider: "openai", model: "gpt-4o", costCents: 1, occurredAt },
    });
    await app.close();
    const scrape = await renderPlacementPrometheusScrape();
    expect(scrape?.body).toBeDefined();
    expect(scrape!.body).toContain("hive_worker_api_requests_total");
    expect(scrape!.body).toContain('route="cost_report"');
    expect(scrape!.body).toContain('status_class="2xx"');
  });

  it("records 401 for in_progress comment without run id", async () => {
    svcMocks.getById.mockResolvedValue({
      id: issueUuid,
      companyId: companyA,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    await app.inject({
      method: "POST",
      url: `/api/worker-api/issues/${issueUuid}/comments`,
      payload: { agentId, body: "x" },
    });
    await app.close();
    const scrape = await renderPlacementPrometheusScrape();
    expect(scrape!.body).toContain('route="issue_comment"');
    expect(scrape!.body).toContain('status_class="401"');
  });

  it("records issue_create for POST /issues", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => workerApiPlugin(f, { db: mockDbWithAgent({ id: agentId, status: "active" }), secretsStrictMode: false }),
      prefix: "/api/worker-api",
      principal: principalWorkerInstance({ workerInstanceRowId: workerInstId, companyId: companyA }),
    });
    await app.inject({
      method: "POST",
      url: "/api/worker-api/issues",
      payload: { agentId, title: "x" },
    });
    await app.close();
    const scrape = await renderPlacementPrometheusScrape();
    expect(scrape!.body).toContain('route="issue_create"');
    expect(scrape!.body).toContain('status_class="2xx"');
  });
});
