import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { approvalsPlugin } from "../routes/approvals.js";
import { createRouteTestFastify, principalBoard } from "./helpers/route-app.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

describe("approval routes idempotent retries", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    app = await createRouteTestFastify({
      plugin: async (fastify) => approvalsPlugin(fastify, { db: {} as Db, strictSecretsMode: false }),
      principal: principalBoard({ companyIds: ["company-1"] }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/approve",
      payload: {},
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    app = await createRouteTestFastify({
      plugin: async (fastify) => approvalsPlugin(fastify, { db: {} as Db, strictSecretsMode: false }),
      principal: principalBoard({ companyIds: ["company-1"] }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/reject",
      payload: {},
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
