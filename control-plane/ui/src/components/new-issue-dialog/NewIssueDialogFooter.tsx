import type { UseMutationResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export function NewIssueDialogFooter({
  title,
  createIssue,
  createIssueErrorMessage,
  canDiscardDraft,
  onDiscardDraft,
  onSubmit,
}: {
  title: string;
  createIssue: UseMutationResult<unknown, Error, { companyId: string } & Record<string, unknown>, unknown>;
  createIssueErrorMessage: string;
  canDiscardDraft: boolean;
  onDiscardDraft: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={onDiscardDraft}
        disabled={createIssue.isPending || !canDiscardDraft}
      >
        Discard Draft
      </Button>
      <div className="flex items-center gap-3">
        <div className="min-h-5 text-right">
          {createIssue.isPending ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Creating issue...
            </span>
          ) : createIssue.isError ? (
            <span className="text-xs text-destructive">{createIssueErrorMessage}</span>
          ) : null}
        </div>
        <Button
          size="sm"
          className="min-w-34 disabled:opacity-100"
          disabled={!title.trim() || createIssue.isPending}
          onClick={onSubmit}
          aria-busy={createIssue.isPending}
        >
          <span className="inline-flex items-center justify-center gap-1.5">
            {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{createIssue.isPending ? "Creating..." : "Create Issue"}</span>
          </span>
        </Button>
      </div>
    </div>
  );
}
