import type { ActivityEvent, IssueComment } from "@hive/shared";

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function formatActivityAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`,
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`,
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId ? "assigned the issue" : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

export function buildCommentsWithRunMeta(
  comments: IssueComment[] | undefined,
  activity: ActivityEvent[] | undefined,
  linkedRuns: Array<{ runId: string; agentId: string | null }> | undefined,
) {
  const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
  const agentIdByRunId = new Map<string, string | null>();
  for (const run of linkedRuns ?? []) {
    agentIdByRunId.set(run.runId, run.agentId);
  }
  for (const evt of activity ?? []) {
    if (evt.action !== "issue.comment_added" || !evt.runId) continue;
    const details = evt.details ?? {};
    const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
    if (!commentId || runMetaByCommentId.has(commentId)) continue;
    runMetaByCommentId.set(commentId, {
      runId: evt.runId,
      runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
    });
  }
  return (comments ?? []).map((comment) => {
    const meta = runMetaByCommentId.get(comment.id);
    return meta ? { ...comment, ...meta } : comment;
  });
}

export function buildIssueCostSummary(
  linkedRuns: Array<{ usageJson?: unknown; resultJson?: unknown }> | undefined,
) {
  let input = 0;
  let output = 0;
  let cached = 0;
  let cost = 0;
  let hasCost = false;
  let hasTokens = false;

  for (const run of linkedRuns ?? []) {
    const usage = asRecord(run.usageJson);
    const result = asRecord(run.resultJson);
    const runInput = usageNumber(usage, "inputTokens", "input_tokens");
    const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
    const runCached = usageNumber(
      usage,
      "cachedInputTokens",
      "cached_input_tokens",
      "cache_read_input_tokens",
    );
    const runCost =
      usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
      usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
    if (runCost > 0) hasCost = true;
    if (runInput + runOutput + runCached > 0) hasTokens = true;
    input += runInput;
    output += runOutput;
    cached += runCached;
    cost += runCost;
  }

  return {
    input,
    output,
    cached,
    cost,
    totalTokens: input + output,
    hasCost,
    hasTokens,
  };
}
