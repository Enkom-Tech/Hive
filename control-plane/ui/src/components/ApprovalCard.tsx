import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Identity } from "./Identity";
import { typeLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@hive/shared";

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />;
  return null;
}

function approvalSummaryLine(approval: Approval): string {
  const payload = approval.payload as Record<string, unknown> | undefined;
  if (!payload) return typeLabel[approval.type] ?? approval.type;
  if (approval.type === "hire_agent") {
    const name = typeof payload.name === "string" ? payload.name : "Agent";
    const adapter = typeof payload.adapterType === "string" ? payload.adapterType : null;
    return adapter ? `${name} · ${adapter}` : name;
  }
  if (approval.type === "approve_ceo_strategy") {
    const title = payload.title ?? payload.description ?? payload.strategy;
    return typeof title === "string" ? title : "CEO Strategy";
  }
  return typeLabel[approval.type] ?? approval.type;
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending,
  variant = "default",
  errorMessage,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove: () => void;
  onReject: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending: boolean;
  variant?: "default" | "compact";
  errorMessage?: string | null;
}) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = typeLabel[approval.type] ?? approval.type;

  if (variant === "compact") {
    const summary = approvalSummaryLine(approval);
    const content = (
      <>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-xs font-medium shrink-0">
            {label}
          </span>
          <span className="truncate text-sm">{summary}</span>
          {requesterAgent && (
            <span className="text-xs text-muted-foreground shrink-0">
              by <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {statusIcon(approval.status)}
          <span className="text-xs text-muted-foreground">{timeAgo(approval.createdAt)}</span>
          {(approval.status === "pending" || approval.status === "revision_requested") && (
            <>
              <Button
                size="sm"
                className="h-8 bg-green-700 hover:bg-green-600 text-white px-2.5"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onApprove(); }}
                disabled={isPending}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-8 px-2.5"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReject(); }}
                disabled={isPending}
              >
                Reject
              </Button>
            </>
          )}
          {!detailLink && (
            <Button variant="ghost" size="sm" className="h-8 text-xs px-2" onClick={onOpen}>
              View details
            </Button>
          )}
        </div>
        {errorMessage && (
          <p className="text-xs text-destructive mt-1">{errorMessage}</p>
        )}
      </>
    );
    const cardClass =
      "flex flex-col gap-2 border border-border rounded-lg p-3 sm:flex-row sm:items-center sm:gap-3 cursor-pointer hover:bg-muted/50 transition-colors";
    if (detailLink) {
      return (
        <Link to={detailLink} className={cardClass}>
          {content}
        </Link>
      );
    }
    return <div className={cardClass}>{content}</div>;
  }

  return (
    <div className="border border-border rounded-lg p-4 space-y-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-xs font-medium shrink-0">
            {label}
          </span>
          {requesterAgent && (
            <span className="text-xs text-muted-foreground">
              requested by <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {statusIcon(approval.status)}
          <span className="text-xs text-muted-foreground capitalize">{approval.status}</span>
          <span className="text-xs text-muted-foreground">· {timeAgo(approval.createdAt)}</span>
        </div>
      </div>

      {/* Payload */}
      <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} />

      {/* Decision note */}
      {approval.decisionNote && (
        <div className="mt-3 text-xs text-muted-foreground italic border-t border-border pt-2">
          Note: {approval.decisionNote}
        </div>
      )}

      {/* Actions */}
      {(approval.status === "pending" || approval.status === "revision_requested") && (
        <div className="flex gap-2 mt-4 pt-3 border-t border-border">
          <Button
            size="sm"
            className="bg-green-700 hover:bg-green-600 text-white"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      )}
      {errorMessage && <p className="text-xs text-destructive mt-2">{errorMessage}</p>}
      <div className="mt-3">
        {detailLink ? (
          <Button variant="ghost" size="sm" className="text-xs px-0" asChild>
            <Link to={detailLink}>View details</Link>
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="text-xs px-0" onClick={onOpen}>
            View details
          </Button>
        )}
      </div>
    </div>
  );
}
