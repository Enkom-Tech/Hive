import { useState } from "react";
import { Link } from "@/lib/router";
import { usePanel } from "../context/PanelContext";
import { IssueProperties } from "../components/IssueProperties";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronRight, EyeOff } from "lucide-react";
import { useIssueDetailPage } from "../hooks/useIssueDetailPage";
import { IssueDetailQualityBanner } from "../components/issue-detail/issue-detail-quality-banner";
import { IssueDetailHeader } from "../components/issue-detail/issue-detail-header";
import { IssueDetailAttachmentsSection } from "../components/issue-detail/issue-detail-attachments-section";
import { IssueDetailMainTabs } from "../components/issue-detail/issue-detail-main-tabs";
import { IssueDetailLinkedCollapses } from "../components/issue-detail/issue-detail-linked-collapses";
import { ISSUE_STATUS_QUALITY_REVIEW } from "@hive/shared";

export function IssueDetail() {
  const { panelVisible, setPanelVisible } = usePanel();
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("comments");
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
    cost: false,
  });

  const {
    issueId,
    location,
    navigate,
    issue,
    isLoading,
    error,
    activity,
    linkedRuns,
    linkedApprovals,
    qualityReviewApproval,
    attachments,
    projects,
    agentMap,
    mentionOptions,
    childIssues,
    commentReassignOptions,
    currentAssigneeValue,
    commentsWithRunMeta,
    issueCostSummary,
    attachmentError,
    updateIssue,
    approveQualityReview,
    rejectQualityReview,
    addComment,
    addCommentAndReassign,
    uploadAttachment,
    deleteAttachment,
    hasLiveRuns,
    timelineRuns,
  } = useIssueDetailPage();

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue || !issueId) return null;

  const ancestors = issue.ancestors ?? [];

  return (
    <div className="max-w-2xl space-y-6">
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={`/issues/${ancestor.identifier ?? ancestor.id}`}
                state={location.state}
                className="hover:text-foreground transition-colors truncate max-w-[200px] cursor-pointer"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      {issue.status === ISSUE_STATUS_QUALITY_REVIEW && (
        <IssueDetailQualityBanner
          qualityReviewApproval={qualityReviewApproval}
          updateIssue={updateIssue}
          approveQualityReview={approveQualityReview}
          rejectQualityReview={rejectQualityReview}
        />
      )}

      <IssueDetailHeader
        issue={issue}
        projects={projects}
        hasLiveRuns={hasLiveRuns}
        mentionOptions={mentionOptions}
        updateIssue={updateIssue}
        uploadAttachment={uploadAttachment}
        navigate={navigate}
        location={location}
        setMobilePropsOpen={setMobilePropsOpen}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        panelVisible={panelVisible}
        setPanelVisible={setPanelVisible}
      />

      <IssueDetailAttachmentsSection
        attachments={attachments}
        attachmentError={attachmentError}
        uploadAttachment={uploadAttachment}
        deleteAttachment={deleteAttachment}
      />

      <Separator />

      <IssueDetailMainTabs
        detailTab={detailTab}
        setDetailTab={setDetailTab}
        issue={issue}
        issueId={issueId}
        commentsWithRunMeta={commentsWithRunMeta}
        timelineRuns={timelineRuns}
        agentMap={agentMap}
        mentionOptions={mentionOptions}
        commentReassignOptions={commentReassignOptions}
        currentAssigneeValue={currentAssigneeValue}
        addComment={addComment}
        addCommentAndReassign={addCommentAndReassign}
        uploadAttachment={uploadAttachment}
        activity={activity}
        childIssues={childIssues}
        location={location}
      />

      <IssueDetailLinkedCollapses
        linkedApprovals={linkedApprovals}
        linkedRuns={linkedRuns}
        secondaryOpen={secondaryOpen}
        setSecondaryOpen={setSecondaryOpen}
        issueCostSummary={issueCostSummary}
      />

      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
