import type { IssueStatus } from "@hive/shared";
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUS_DONE,
  ISSUE_STATUS_CANCELLED,
  ISSUE_STATUS_IN_REVIEW,
  ISSUE_STATUS_QUALITY_REVIEW,
  ISSUE_STATUS_TODO,
  ISSUE_STATUS_BLOCKED,
} from "@hive/shared";
import { conflict } from "../../errors.js";
import { issues } from "@hive/db";

export const ALLOWED_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  backlog: [ISSUE_STATUS_TODO, ISSUE_STATUS_CANCELLED],
  todo: [ISSUE_STATUS_IN_PROGRESS, ISSUE_STATUS_BLOCKED, ISSUE_STATUS_CANCELLED],
  in_progress: [
    ISSUE_STATUS_IN_REVIEW,
    ISSUE_STATUS_QUALITY_REVIEW,
    ISSUE_STATUS_BLOCKED,
    ISSUE_STATUS_DONE,
    ISSUE_STATUS_CANCELLED,
  ],
  in_review: [
    ISSUE_STATUS_IN_PROGRESS,
    ISSUE_STATUS_QUALITY_REVIEW,
    ISSUE_STATUS_DONE,
    ISSUE_STATUS_CANCELLED,
  ],
  quality_review: [ISSUE_STATUS_IN_PROGRESS, ISSUE_STATUS_DONE, ISSUE_STATUS_CANCELLED],
  blocked: [ISSUE_STATUS_TODO, ISSUE_STATUS_IN_PROGRESS, ISSUE_STATUS_CANCELLED],
  done: [],
  cancelled: [],
};

export function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!(ISSUE_STATUSES as readonly string[]).includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
  const allowed = ALLOWED_TRANSITIONS[from as IssueStatus];
  if (!allowed?.includes(to as IssueStatus)) {
    throw conflict(`Invalid status transition: ${from} -> ${to}`);
  }
}

export function effectiveQualityReviewRequired(
  issue: { requiresQualityReview: boolean | null },
  company: { requireQualityReviewForDone: boolean },
): boolean {
  return issue.requiresQualityReview ?? company.requireQualityReviewForDone;
}

export function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === ISSUE_STATUS_IN_PROGRESS && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === ISSUE_STATUS_DONE) {
    patch.completedAt = new Date();
  }
  if (status === ISSUE_STATUS_CANCELLED) {
    patch.cancelledAt = new Date();
  }
  return patch;
}
