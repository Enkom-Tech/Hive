import { describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import {
  ISSUE_STATUS_DONE,
  ISSUE_STATUS_BLOCKED,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUS_QUALITY_REVIEW,
} from "@hive/shared";
import { standupService } from "../services/standup.js";

const companyId = "550e8400-e29b-41d4-a716-446655440000";
const agent1Id = "660e8400-e29b-41d4-a716-446655440001";
const agent2Id = "660e8400-e29b-41d4-a716-446655440002";

const now = new Date();
const oneHourAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);

function createMockDb(opts: {
  companyExists: boolean;
  agentRows: Array<{ id: string; name: string }>;
  issueRows: Array<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    startedAt: Date | null;
    completedAt: Date | null;
    assigneeAgentId: string | null;
  }>;
}): Db {
  let queryCount = 0;
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: (cb: (rows: unknown[]) => unknown) => {
            queryCount += 1;
            if (queryCount === 1) {
              return Promise.resolve(cb(opts.companyExists ? [{}] : []));
            }
            if (queryCount === 2) {
              return Promise.resolve(cb(opts.agentRows));
            }
            return Promise.resolve(cb(opts.issueRows));
          },
        }),
      }),
    }),
  } as unknown as Db;
}

describe("standupService.getReport", () => {
  it("throws notFound when company does not exist", async () => {
    const db = createMockDb({
      companyExists: false,
      agentRows: [],
      issueRows: [],
    });
    const svc = standupService(db);
    await expect(svc.getReport(companyId)).rejects.toMatchObject({
      message: "Company not found",
      status: 404,
    });
  });

  it("returns report with agent buckets, teamAccomplishments, blockers, overdue", async () => {
    const db = createMockDb({
      companyExists: true,
      agentRows: [
        { id: agent1Id, name: "Agent One" },
        { id: agent2Id, name: "Agent Two" },
      ],
      issueRows: [
        {
          id: "issue-done",
          identifier: "P-1",
          title: "Completed task",
          status: ISSUE_STATUS_DONE,
          startedAt: twelveHoursAgo,
          completedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
          assigneeAgentId: agent1Id,
        },
        {
          id: "issue-blocked",
          identifier: "P-2",
          title: "Blocked task",
          status: ISSUE_STATUS_BLOCKED,
          startedAt: null,
          completedAt: null,
          assigneeAgentId: agent1Id,
        },
        {
          id: "issue-stale",
          identifier: "P-3",
          title: "Stale in progress",
          status: ISSUE_STATUS_IN_PROGRESS,
          startedAt: oneHourAgo,
          completedAt: null,
          assigneeAgentId: agent2Id,
        },
        {
          id: "issue-quality-review",
          identifier: "P-4",
          title: "In quality review",
          status: ISSUE_STATUS_QUALITY_REVIEW,
          startedAt: null,
          completedAt: null,
          assigneeAgentId: agent1Id,
        },
      ],
    });
    const svc = standupService(db);
    const report = await svc.getReport(companyId);

    expect(report.companyId).toBe(companyId);
    expect(report.generatedAt).toBeDefined();
    expect(report.agents).toHaveLength(2);

    const agent1 = report.agents.find((a) => a.agentId === agent1Id);
    expect(agent1?.name).toBe("Agent One");
    expect(agent1?.completed).toHaveLength(1);
    expect(agent1?.completed[0].title).toBe("Completed task");
    expect(agent1?.blocked).toHaveLength(1);
    expect(agent1?.blocked[0].title).toBe("Blocked task");

    const agent2 = report.agents.find((a) => a.agentId === agent2Id);
    expect(agent2?.inProgress).toHaveLength(1);
    expect(agent2?.inProgress[0].title).toBe("Stale in progress");

    expect(report.teamAccomplishments).toHaveLength(1);
    expect(report.teamAccomplishments[0].title).toBe("Completed task");

    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0].title).toBe("Blocked task");

    expect(report.overdue).toHaveLength(1);
    expect(report.overdue[0].title).toBe("Stale in progress");

    expect(agent1?.review).toHaveLength(1);
    expect(agent1?.review[0].title).toBe("In quality review");
    expect(agent1?.review[0].status).toBe("quality_review");
  });
});
