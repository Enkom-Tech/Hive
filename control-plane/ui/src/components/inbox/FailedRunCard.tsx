import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { timeAgo } from "../../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, RotateCcw, X, XCircle } from "lucide-react";
import { Identity } from "../Identity";
import { StatusBadge } from "../StatusBadge";
import type { HeartbeatRun, Issue } from "@hive/shared";
import { readIssueIdFromRun, RUN_SOURCE_LABELS, runFailureMessage } from "../../lib/inbox";

export function FailedRunCard({
  run,
  issueById,
  agentName: linkedAgentName,
  issueLinkState,
  onDismiss,
}: {
  run: HeartbeatRun;
  issueById: Map<string, Issue>;
  agentName: string | null;
  issueLinkState: unknown;
  onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const issueId = readIssueIdFromRun(run);
  const issue = issueId ? (issueById.get(issueId) ?? null) : null;
  const sourceLabel = RUN_SOURCE_LABELS[run.invocationSource] ?? "Manual";
  const displayError = runFailureMessage(run);

  const retryRun = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      const context = run.contextSnapshot as Record<string, unknown> | null;
      if (context) {
        if (typeof context.issueId === "string" && context.issueId) payload.issueId = context.issueId;
        if (typeof context.taskId === "string" && context.taskId) payload.taskId = context.taskId;
        if (typeof context.taskKey === "string" && context.taskKey) payload.taskKey = context.taskKey;
      }
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload,
      });
      if (!("id" in result)) {
        throw new Error("Retry was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${run.agentId}/runs/${newRun.id}`);
    },
  });

  return (
    <div className="group relative overflow-hidden rounded-xl border border-red-500/30 bg-linear-to-br from-red-500/10 via-card to-card p-4">
      <div className="absolute right-0 top-0 h-24 w-24 rounded-full bg-red-500/10 blur-2xl" />
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-2 top-2 z-10 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="relative space-y-3">
        {issue ? (
          <Link
            to={`/issues/${issue.identifier ?? issue.id}`}
            state={issueLinkState}
            className="block truncate text-sm font-medium transition-colors hover:text-foreground no-underline text-inherit"
          >
            <span className="font-mono text-muted-foreground mr-1.5">
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
            {issue.title}
          </Link>
        ) : (
          <span className="block text-sm text-muted-foreground">
            {run.errorCode ? `Error code: ${run.errorCode}` : "No linked issue"}
          </span>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-red-500/20 p-1.5">
                <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
              </span>
              {linkedAgentName ? (
                <Identity name={linkedAgentName} size="sm" />
              ) : (
                <span className="text-sm font-medium">Agent {run.agentId.slice(0, 8)}</span>
              )}
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {sourceLabel} run failed {timeAgo(run.createdAt)}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 px-2.5"
              onClick={() => retryRun.mutate()}
              disabled={retryRun.isPending}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {retryRun.isPending ? "Retrying…" : "Retry"}
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 px-2.5" asChild>
              <Link to={`/agents/${run.agentId}/runs/${run.id}`}>
                Open run
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm">{displayError}</div>

        <div className="text-xs">
          <span className="font-mono text-muted-foreground">run {run.id.slice(0, 8)}</span>
        </div>

        {retryRun.isError && (
          <div className="text-xs text-destructive">
            {retryRun.error instanceof Error ? retryRun.error.message : "Failed to retry run"}
          </div>
        )}
      </div>
    </div>
  );
}
