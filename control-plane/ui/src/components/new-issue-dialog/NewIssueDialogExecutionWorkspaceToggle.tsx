import { cn } from "../../lib/utils";

export function NewIssueDialogExecutionWorkspaceToggle({
  useIsolatedExecutionWorkspace,
  setUseIsolatedExecutionWorkspace,
}: {
  useIsolatedExecutionWorkspace: boolean;
  setUseIsolatedExecutionWorkspace: (value: boolean | ((prev: boolean) => boolean)) => void;
}) {
  return (
    <div className="px-4 pb-2 shrink-0">
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
        <div className="space-y-0.5">
          <div className="text-xs font-medium">Use isolated issue checkout</div>
          <div className="text-[11px] text-muted-foreground">
            Create an issue-specific execution workspace instead of using the project&apos;s primary checkout.
          </div>
        </div>
        <button
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
            useIsolatedExecutionWorkspace ? "bg-green-600" : "bg-muted",
          )}
          onClick={() => setUseIsolatedExecutionWorkspace((value) => !value)}
          type="button"
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              useIsolatedExecutionWorkspace ? "translate-x-4.5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </div>
  );
}
