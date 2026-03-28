import type { UseMutationResult } from "@tanstack/react-query";
import { Link, type Location } from "@/lib/router";
import type { Issue, IssueAttachment, Project } from "@hive/shared";
import { cn } from "../../lib/utils";
import { InlineEditor } from "../InlineEditor";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { EyeOff, Hexagon, MoreHorizontal, SlidersHorizontal } from "lucide-react";
import type { MentionOption } from "../markdown-editor-types";

export function IssueDetailHeader({
  issue,
  projects,
  hasLiveRuns,
  mentionOptions,
  updateIssue,
  uploadAttachment,
  navigate,
  location,
  setMobilePropsOpen,
  moreOpen,
  setMoreOpen,
  panelVisible,
  setPanelVisible,
}: {
  issue: Issue;
  projects: Project[] | undefined;
  hasLiveRuns: boolean;
  mentionOptions: MentionOption[];
  updateIssue: UseMutationResult<unknown, Error, Record<string, unknown>, unknown>;
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
  navigate: (to: string, opts?: { replace?: boolean; state?: Location["state"] }) => void;
  location: Location;
  setMobilePropsOpen: (open: boolean) => void;
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
  panelVisible: boolean;
  setPanelVisible: (visible: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <StatusIcon status={issue.status} onChange={(status) => updateIssue.mutate({ status })} />
        <PriorityIcon
          priority={issue.priority}
          onChange={(priority) => updateIssue.mutate({ priority })}
        />
        <span className="text-sm font-mono text-muted-foreground shrink-0">
          {issue.identifier ?? issue.id.slice(0, 8)}
        </span>

        {hasLiveRuns && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
            </span>
            Live
          </span>
        )}

        {issue.projectId ? (
          <Link
            to={`/projects/${issue.projectId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0 cursor-pointer"
          >
            <Hexagon className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {(projects ?? []).find((p) => p.id === issue.projectId)?.name ?? issue.projectId.slice(0, 8)}
            </span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
            <Hexagon className="h-3 w-3 shrink-0" />
            No project
          </span>
        )}

        {(issue.labels ?? []).length > 0 && (
          <div className="hidden sm:flex items-center gap-1">
            {(issue.labels ?? []).slice(0, 4).map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: label.color,
                  color: label.color,
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </span>
            ))}
            {(issue.labels ?? []).length > 4 && (
              <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
            )}
          </div>
        )}

        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto md:hidden shrink-0"
          onClick={() => setMobilePropsOpen(true)}
          title="Properties"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>

        <div className="hidden md:flex items-center md:ml-auto shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "shrink-0 transition-opacity duration-200",
              panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
            )}
            onClick={() => setPanelVisible(true)}
            title="Show properties"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>

          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="shrink-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive cursor-pointer"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <InlineEditor
        value={issue.title}
        onSave={(title) => updateIssue.mutate({ title })}
        as="h2"
        className="text-xl font-bold"
      />

      <InlineEditor
        value={issue.description ?? ""}
        onSave={(description) => updateIssue.mutate({ description })}
        as="p"
        className="text-[15px] leading-7 text-foreground"
        placeholder="Add a description..."
        multiline
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
      />
    </div>
  );
}
