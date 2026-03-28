import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbTransaction } from "@hive/db";
import { HEARTBEAT_RUN_TERMINAL_STATUS_SET } from "@hive/shared";
import { heartbeatRuns, issueComments, issueLabels, issueReadStates, issues, labels } from "@hive/db";

/** DB or transaction client for batched issue label/run queries. */
export type IssueQueryDb = Db | DbTransaction;
export type IssueRow = typeof issues.$inferSelect;
export type IssueLabelRow = typeof labels.$inferSelect;
export type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
export type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
export type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };

export function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

/** @deprecated Use HEARTBEAT_RUN_TERMINAL_STATUS_SET from @hive/shared */
export const TERMINAL_HEARTBEAT_RUN_STATUSES = HEARTBEAT_RUN_TERMINAL_STATUS_SET;

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

export function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

export async function labelMapForIssues(dbOrTx: IssueQueryDb, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  const rows = await dbOrTx
    .select({
      issueId: issueLabels.issueId,
      label: labels,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(asc(labels.name), asc(labels.id));

  for (const row of rows) {
    const existing = map.get(row.issueId);
    if (existing) existing.push(row.label);
    else map.set(row.issueId, [row.label]);
  }
  return map;
}

export async function withIssueLabels(dbOrTx: IssueQueryDb, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabelsList = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabelsList,
      labelIds: issueLabelsList.map((label) => label.id),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];

export async function activeRunMapForIssues(
  dbOrTx: IssueQueryDb,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows.map((row) => row.executionRunId).filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  const rows = await dbOrTx
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.id, runIds), inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES)));

  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

export function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}
