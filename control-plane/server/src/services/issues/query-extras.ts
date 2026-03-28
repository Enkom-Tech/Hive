import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, goals, issueComments, issues, projectWorkspaces, projects } from "@hive/db";
import { extractProjectMentionIds } from "@hive/shared";

type AncestorChainRow = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  projectId: string | null;
  goalId: string | null;
};

export function createIssueQueryExtras(db: Db) {
  return {
    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) tokens.add(m[1].toLowerCase());
      if (tokens.size === 0) return [];
      const tokenList = [...tokens];
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            sql`lower(${agents.name}) in (${sql.join(
              tokenList.map((t) => sql`${t}`),
              sql`, `,
            )})`,
          ),
        );
      return rows.map((a) => a.id);
    },

    findMentionedProjectIds: async (issueId: string) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));

      const mentionedIds = new Set<string>();
      for (const source of [
        issue.title,
        issue.description ?? "",
        ...comments.map((comment) => comment.body),
      ]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }
      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const chainResult = await db.execute(sql`
        WITH RECURSIVE ancestors AS (
          SELECT
            i.id,
            i.identifier,
            i.title,
            i.description,
            i.status,
            i.priority,
            i.assignee_agent_id AS "assigneeAgentId",
            i.project_id AS "projectId",
            i.goal_id AS "goalId",
            i.parent_id AS "parentId",
            1 AS depth
          FROM issues i
          WHERE i.id = (SELECT parent_id FROM issues WHERE id = ${issueId})

          UNION ALL

          SELECT
            i.id,
            i.identifier,
            i.title,
            i.description,
            i.status,
            i.priority,
            i.assignee_agent_id AS "assigneeAgentId",
            i.project_id AS "projectId",
            i.goal_id AS "goalId",
            i.parent_id AS "parentId",
            a.depth + 1 AS depth
          FROM issues i
          INNER JOIN ancestors a ON i.id = a."parentId"
          WHERE a.depth < 50
        )
        SELECT
          id,
          identifier,
          title,
          description,
          status,
          priority,
          "assigneeAgentId",
          "projectId",
          "goalId"
        FROM ancestors
        ORDER BY depth
      `);

      const asRows = Array.isArray(chainResult)
        ? [...chainResult]
        : (chainResult as { rows?: unknown[] }).rows
          ? [...((chainResult as { rows: unknown[] }).rows)]
          : [...(chainResult as Iterable<unknown>)];
      const chainRows = asRows as AncestorChainRow[];

      const projectIds = [...new Set(chainRows.map((a) => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(chainRows.map((a) => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return chainRows.map((a) => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
