import type { UseMutationResult } from "@tanstack/react-query";
import { Link, type Location } from "@/lib/router";
import type { ActivityEvent, Agent, Issue, IssueAttachment, IssueComment } from "@hive/shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  ListTree,
  MessageSquare,
} from "lucide-react";
import { CommentThread } from "../CommentThread";
import { LiveRunWidget } from "../LiveRunWidget";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";
import { Identity } from "../Identity";
import type { MentionOption } from "../markdown-editor-types";
import type { RunForIssue } from "../../api/activity";
import { formatActivityAction } from "./issue-detail-activity-format";
import { IssueDetailActorIdentity } from "./issue-detail-actor-identity";
import { relativeTime } from "../../lib/utils";
import type { CommentReassignment } from "./issue-detail-types";

type CommentWithRunMeta = IssueComment & { runId?: string; runAgentId?: string | null };

export function IssueDetailMainTabs({
  detailTab,
  setDetailTab,
  issue,
  issueId,
  commentsWithRunMeta,
  timelineRuns,
  agentMap,
  mentionOptions,
  commentReassignOptions,
  currentAssigneeValue,
  addComment,
  addCommentAndReassign,
  uploadAttachment,
  activity,
  childIssues,
  location,
}: {
  detailTab: string;
  setDetailTab: (tab: string) => void;
  issue: Issue;
  issueId: string;
  commentsWithRunMeta: CommentWithRunMeta[];
  timelineRuns: RunForIssue[];
  agentMap: Map<string, Agent>;
  mentionOptions: MentionOption[];
  commentReassignOptions: Array<{ id: string; label: string; searchText?: string }>;
  currentAssigneeValue: string;
  addComment: UseMutationResult<unknown, Error, { body: string; reopen?: boolean }, unknown>;
  addCommentAndReassign: UseMutationResult<
    unknown,
    Error,
    { body: string; reopen?: boolean; reassignment: CommentReassignment },
    unknown
  >;
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
  activity: ActivityEvent[] | undefined;
  childIssues: Issue[];
  location: Location;
}) {
  return (
    <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
      <TabsList variant="line" className="w-full justify-start gap-1">
        <TabsTrigger value="comments" className="gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />
          Comments
        </TabsTrigger>
        <TabsTrigger value="subissues" className="gap-1.5">
          <ListTree className="h-3.5 w-3.5" />
          Sub-issues
        </TabsTrigger>
        <TabsTrigger value="activity" className="gap-1.5">
          <ActivityIcon className="h-3.5 w-3.5" />
          Activity
        </TabsTrigger>
      </TabsList>

      <TabsContent value="comments">
        <CommentThread
          comments={commentsWithRunMeta}
          linkedRuns={timelineRuns}
          issueStatus={issue.status}
          agentMap={agentMap}
          draftKey={`hive:issue-comment-draft:${issue.id}`}
          enableReassign
          reassignOptions={commentReassignOptions}
          currentAssigneeValue={currentAssigneeValue}
          mentions={mentionOptions}
          onAdd={async (body, reopen, reassignment) => {
            if (reassignment) {
              await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
              return;
            }
            await addComment.mutateAsync({ body, reopen });
          }}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
          onAttachImage={async (file) => {
            await uploadAttachment.mutateAsync(file);
          }}
          liveRunSlot={<LiveRunWidget issueId={issueId} companyId={issue.companyId} />}
        />
      </TabsContent>

      <TabsContent value="subissues">
        {childIssues.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sub-issues.</p>
        ) : (
          <div className="border border-border rounded-lg divide-y divide-border">
            {childIssues.map((child) => (
              <Link
                key={child.id}
                to={`/issues/${child.identifier ?? child.id}`}
                state={location.state}
                className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusIcon status={child.status} />
                  <PriorityIcon priority={child.priority} />
                  <span className="font-mono text-muted-foreground shrink-0">
                    {child.identifier ?? child.id.slice(0, 8)}
                  </span>
                  <span className="truncate">{child.title}</span>
                </div>
                {child.assigneeAgentId && (() => {
                  const name = agentMap.get(child.assigneeAgentId)?.name;
                  return name ? (
                    <Identity name={name} size="sm" />
                  ) : (
                    <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>
                  );
                })()}
              </Link>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="activity">
        {!activity || activity.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <div className="space-y-1.5">
            {activity.slice(0, 20).map((evt) => (
              <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <IssueDetailActorIdentity evt={evt} agentMap={agentMap} />
                <span>{formatActivityAction(evt.action, evt.details)}</span>
                <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
