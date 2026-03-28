import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db, DbTransaction } from "@hive/db";
import {
  approvals,
  assets,
  companies,
  goals,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueLabels,
  issueReadStates,
  issues,
  projects,
} from "@hive/db";
import {
  ISSUE_STATUS_CANCELLED,
  ISSUE_STATUS_DONE,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUS_IN_REVIEW,
  ISSUE_STATUS_QUALITY_REVIEW,
  ISSUE_STATUS_TODO,
} from "@hive/shared";
import { unprocessable } from "../../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  parseProjectExecutionWorkspacePolicy,
} from "../execution-workspace-policy.js";
import { teardownIssueExecutionWorkspaceOnTerminal } from "../workspace-runtime.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "../issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "../goals.js";
import {
  activeRunMapForIssues,
  escapeLikePattern,
  touchedByUserCondition,
  unreadForUserCondition,
  withActiveRuns,
  withIssueLabels,
} from "./query-helpers.js";
import {
  assertTransition,
  applyStatusSideEffects,
  effectiveQualityReviewRequired,
} from "./transitions.js";
import { deriveIssueUserContext } from "./user-context.js";
import type { IssueFilters } from "./types.js";
import type { createAssigneeAssertions } from "./assignees.js";
import type { createIssueLabelOps } from "./labels-ops.js";

type AssigneeAssertions = ReturnType<typeof createAssigneeAssertions>;
type LabelOps = ReturnType<typeof createIssueLabelOps>;

export function createIssueCrudOps(db: Db, assignees: AssigneeAssertions, labelOps: LabelOps) {
  const { assertAssignableAgent, assertAssignableUser } = assignees;
  const { syncIssueLabels } = labelOps;

  async function createInTxImpl(
    tx: DbTransaction,
    companyId: string,
    data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
  ) {
    const { labelIds: inputLabelIds, ...issueData } = data;
    const defaultCompanyGoal = await getDefaultCompanyGoal(tx, companyId);
    let executionWorkspaceSettings =
      (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
    if (executionWorkspaceSettings == null && issueData.projectId) {
      const project = await tx
        .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
        .from(projects)
        .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      executionWorkspaceSettings =
        defaultIssueExecutionWorkspaceSettingsForProject(
          parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
        ) as Record<string, unknown> | null;
    }
    const [company] = await tx
      .update(companies)
      .set({ issueCounter: sql`${companies.issueCounter} + 1` })
      .where(eq(companies.id, companyId))
      .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

    const issueNumber = company.issueCounter;
    const identifier = `${company.issuePrefix}-${issueNumber}`;

    const values = {
      ...issueData,
      goalId: resolveIssueGoalId({
        projectId: issueData.projectId,
        goalId: issueData.goalId,
        defaultGoalId: defaultCompanyGoal?.id ?? null,
      }),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
      companyId,
      issueNumber,
      identifier,
    } as typeof issues.$inferInsert;
    if (values.status === ISSUE_STATUS_IN_PROGRESS && !values.startedAt) {
      values.startedAt = new Date();
    }
    if (values.status === ISSUE_STATUS_DONE) {
      values.completedAt = new Date();
    }
    if (values.status === ISSUE_STATUS_CANCELLED) {
      values.cancelledAt = new Date();
    }

    const [issue] = await tx.insert(issues).values(values).returning();
    if (inputLabelIds) {
      await syncIssueLabels(issue.id, companyId, inputLabelIds, tx);
    }
    const [enriched] = await withIssueLabels(tx, [issue]);
    return enriched;
  }

  return {
    list: async (companyId: string, filters?: IssueFilters) => {
      const conditions = [eq(issues.companyId, companyId)];
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (filters?.departmentId) {
        conditions.push(eq(issues.departmentId, filters.departmentId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${descriptionContainsMatch} THEN 4
          WHEN ${commentContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const rows = await db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(hasSearch ? asc(searchOrder) : asc(priorityOrder), asc(priorityOrder), desc(issues.updatedAt));
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (!contextUserId || withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const statsRows = await db
        .select({
          issueId: issueComments.issueId,
          myLastCommentAt: sql<Date | null>`
            MAX(CASE WHEN ${issueComments.authorUserId} = ${contextUserId} THEN ${issueComments.createdAt} END)
          `,
          lastExternalCommentAt: sql<Date | null>`
            MAX(
              CASE
                WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${contextUserId}
                THEN ${issueComments.createdAt}
              END
            )
          `,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIds),
          ),
        )
        .groupBy(issueComments.issueId);
      const readRows = await db
        .select({
          issueId: issueReadStates.issueId,
          myLastReadAt: issueReadStates.lastReadAt,
        })
        .from(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.userId, contextUserId),
            inArray(issueReadStates.issueId, issueIds),
          ),
        );
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => ({
        ...row,
        ...deriveIssueUserContext(row, contextUserId, {
          myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
          myLastReadAt: readByIssueId.get(row.id) ?? null,
          lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
        }),
      }));
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        unreadForUserCondition(companyId, userId),
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(issues.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(issues.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    getByIdentifier: async (identifier: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.identifier, identifier.toUpperCase()))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    create: async (
      companyId: string,
      data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
    ) => {
      const { labelIds: inputLabelIds, ...issueData } = data;
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (data.status === ISSUE_STATUS_IN_PROGRESS && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      return db.transaction(async (tx) => createInTxImpl(tx, companyId, data));
    },

    validateIssueCreateAssignees: async (
      companyId: string,
      data: {
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
        status?: string;
      },
    ) => {
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (
        data.status === ISSUE_STATUS_IN_PROGRESS &&
        !data.assigneeAgentId &&
        !data.assigneeUserId
      ) {
        throw unprocessable("in_progress issues require an assignee");
      }
    },

    createInTx: async (
      tx: DbTransaction,
      companyId: string,
      data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
    ) => createInTxImpl(tx, companyId, data),

    update: async (id: string, data: Partial<typeof issues.$inferInsert> & { labelIds?: string[] }) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const { labelIds: nextLabelIds, ...issueData } = data;

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }

      let company: { requireQualityReviewForDone: boolean } | null = null;
      if (
        issueData.status === ISSUE_STATUS_DONE ||
        issueData.status === ISSUE_STATUS_QUALITY_REVIEW
      ) {
        const [row] = await db
          .select({ requireQualityReviewForDone: companies.requireQualityReviewForDone })
          .from(companies)
          .where(eq(companies.id, existing.companyId));
        company = row ?? null;
      }

      if (issueData.status === ISSUE_STATUS_DONE && company) {
        const effective = effectiveQualityReviewRequired(existing, company);
        if (existing.status === ISSUE_STATUS_IN_REVIEW && effective) {
          throw unprocessable(
            "Quality review required. Move to Quality review first, then get board sign-off before marking done.",
          );
        }
        if (existing.status === ISSUE_STATUS_QUALITY_REVIEW && effective) {
          const [approved] = await db
            .select({ id: approvals.id })
            .from(issueApprovals)
            .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
            .where(
              and(
                eq(issueApprovals.issueId, id),
                eq(approvals.type, "quality_review"),
                eq(approvals.status, "approved"),
              ),
            )
            .limit(1);
          if (!approved) {
            throw unprocessable(
              "Quality review approval required before marking done.",
            );
          }
        }
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (patch.status === ISSUE_STATUS_IN_PROGRESS && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, issueData.assigneeAgentId);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, issueData.assigneeUserId);
      }

      applyStatusSideEffects(issueData.status, patch);
      if (issueData.status && issueData.status !== ISSUE_STATUS_DONE) {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== ISSUE_STATUS_CANCELLED) {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== ISSUE_STATUS_IN_PROGRESS) {
        patch.checkoutRunId = null;
      }
      if (issueData.status === ISSUE_STATUS_DONE || issueData.status === ISSUE_STATUS_CANCELLED) {
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
      }

      const enriched = await db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          projectId: issueData.projectId,
          goalId: issueData.goalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (
          issueData.status === ISSUE_STATUS_QUALITY_REVIEW &&
          company &&
          effectiveQualityReviewRequired(
            { requiresQualityReview: updated.requiresQualityReview },
            company,
          )
        ) {
          const existingQr = await tx
            .select({ approvalId: issueApprovals.approvalId })
            .from(issueApprovals)
            .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
            .where(
              and(
                eq(issueApprovals.issueId, id),
                eq(approvals.type, "quality_review"),
              ),
            )
            .limit(1);
          if (existingQr.length === 0) {
            const [approval] = await tx
              .insert(approvals)
              .values({
                companyId: existing.companyId,
                type: "quality_review",
                status: "pending",
                payload: { issueId: id },
              })
              .returning();
            await tx.insert(issueApprovals).values({
              companyId: existing.companyId,
              issueId: id,
              approvalId: approval.id,
            });
          }
        }
        const [row] = await withIssueLabels(tx, [updated]);
        return row;
      });

      if (
        enriched &&
        issueData.status &&
        (issueData.status === ISSUE_STATUS_DONE || issueData.status === ISSUE_STATUS_CANCELLED)
      ) {
        void teardownIssueExecutionWorkspaceOnTerminal(db, id).catch(() => {
          /* best-effort */
        });
      }

      return enriched;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),
  };
}
