import type { UseMutationResult } from "@tanstack/react-query";
import type { Approval } from "@hive/shared";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "../StatusBadge";
import { relativeTime } from "../../lib/utils";

export function IssueDetailQualityBanner({
  qualityReviewApproval,
  updateIssue,
  approveQualityReview,
  rejectQualityReview,
}: {
  qualityReviewApproval: Approval | null | undefined;
  updateIssue: UseMutationResult<unknown, Error, Record<string, unknown>, unknown>;
  approveQualityReview: UseMutationResult<unknown, Error, string, unknown>;
  rejectQualityReview: UseMutationResult<unknown, Error, string, unknown>;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 space-y-2">
      <div className="text-sm font-medium text-amber-700 dark:text-amber-400">Quality review</div>
      {qualityReviewApproval == null ? (
        <p className="text-xs text-muted-foreground">No quality review approval linked.</p>
      ) : qualityReviewApproval.status === "approved" ? (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            Approved
            {qualityReviewApproval.decidedByUserId && ` by ${qualityReviewApproval.decidedByUserId}`}
            {qualityReviewApproval.decidedAt != null &&
              ` ${relativeTime(qualityReviewApproval.decidedAt)}`}.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => updateIssue.mutate({ status: "done" })}
            disabled={updateIssue.isPending}
          >
            Mark done
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={qualityReviewApproval.status} />
          <Button
            size="sm"
            onClick={() => approveQualityReview.mutate(qualityReviewApproval.id)}
            disabled={approveQualityReview.isPending}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rejectQualityReview.mutate(qualityReviewApproval.id)}
            disabled={rejectQualityReview.isPending}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
