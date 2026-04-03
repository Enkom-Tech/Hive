import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, companies, issues } from "@hive/db";
import { notFound } from "../errors.js";
import {
  ISSUE_STATUS_BLOCKED,
  ISSUE_STATUS_CANCELLED,
  ISSUE_STATUS_DONE,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUS_IN_REVIEW,
  ISSUE_STATUS_QUALITY_REVIEW,
  ISSUE_STATUS_TODO,
  type StandupReport,
  type StandupAgentSection,
  type StandupIssueSummary,
} from "@hive/shared";

const STALE_CUTOFF_MS = 60 * 60 * 1000; // 1 hour
const TEAM_ACCOMPLISHMENTS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function toSummary(row: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  assigneeAgentId: string | null;
}): StandupIssueSummary {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    assigneeAgentId: row.assigneeAgentId,
  };
}

export function standupService(db: Db) {
  return {
    getReport: async (companyId: string): Promise<StandupReport> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const companyAgents = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

      const allIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            ne(issues.status, ISSUE_STATUS_CANCELLED),
            isNull(issues.hiddenAt),
          ),
        );

      const now = new Date();
      const staleCutoff = new Date(now.getTime() - STALE_CUTOFF_MS);
      const accomplishmentsCutoff = new Date(now.getTime() - TEAM_ACCOMPLISHMENTS_WINDOW_MS);

      const agentSections: StandupAgentSection[] = companyAgents.map((a) => ({
        agentId: a.id,
        name: a.name,
        completed: [],
        inProgress: [],
        assigned: [],
        review: [],
        blocked: [],
      }));

      const agentSectionByAgentId = new Map(agentSections.map((s) => [s.agentId, s]));

      const teamAccomplishments: StandupIssueSummary[] = [];
      const blockers: StandupIssueSummary[] = [];
      const overdue: StandupIssueSummary[] = [];

      for (const row of allIssues) {
        const summary = toSummary(row);

        if (row.status === ISSUE_STATUS_DONE) {
          if (row.completedAt && row.completedAt >= accomplishmentsCutoff) {
            teamAccomplishments.push(summary);
          }
          if (row.assigneeAgentId) {
            const section = agentSectionByAgentId.get(row.assigneeAgentId);
            if (section) section.completed.push(summary);
          }
          continue;
        }

        if (row.status === ISSUE_STATUS_BLOCKED) {
          blockers.push(summary);
          if (row.assigneeAgentId) {
            const section = agentSectionByAgentId.get(row.assigneeAgentId);
            if (section) section.blocked.push(summary);
          }
          continue;
        }

        if (row.status === ISSUE_STATUS_IN_PROGRESS) {
          if (row.startedAt && row.startedAt < staleCutoff) {
            overdue.push(summary);
          }
          if (row.assigneeAgentId) {
            const section = agentSectionByAgentId.get(row.assigneeAgentId);
            if (section) section.inProgress.push(summary);
          }
          continue;
        }

        if (row.status === ISSUE_STATUS_IN_REVIEW || row.status === ISSUE_STATUS_QUALITY_REVIEW) {
          if (row.assigneeAgentId) {
            const section = agentSectionByAgentId.get(row.assigneeAgentId);
            if (section) section.review.push(summary);
          }
          continue;
        }

        if (row.status === ISSUE_STATUS_TODO && row.assigneeAgentId) {
          const section = agentSectionByAgentId.get(row.assigneeAgentId);
          if (section) section.assigned.push(summary);
        }
      }

      return {
        companyId,
        generatedAt: now.toISOString(),
        agents: agentSections,
        teamAccomplishments,
        blockers,
        overdue,
      };
    },
  };
}
