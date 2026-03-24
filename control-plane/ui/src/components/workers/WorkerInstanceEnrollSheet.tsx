import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { CopyText } from "../CopyText";
import { workersApi } from "@/api/workers";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import { getBoardApiBase } from "@/lib/worker-client-hints";
import { useWorkerDownloadHints } from "./WorkerDownloadPanel";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  workerInstanceId: string;
  /** Short label for the drone row (hostname or instance id prefix). */
  droneLabel: string;
};

/**
 * Mint an instance-scoped link enrollment token (ADR 003). Enrolls the WebSocket for this
 * `worker_instances` row — all board agents bound to this instance receive runs on that link.
 */
export function WorkerInstanceEnrollSheet({
  open,
  onOpenChange,
  companyId,
  workerInstanceId,
  droneLabel,
}: Props) {
  const queryClient = useQueryClient();
  const { binHint } = useWorkerDownloadHints();
  const apiBase = getBoardApiBase();

  const mint = useMutation({
    mutationFn: () => workersApi.createInstanceLinkEnrollmentToken(companyId, workerInstanceId, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(companyId) });
    },
  });

  const token = mint.data?.token;
  const expiresAt = mint.data?.expiresAt;

  const posixBlock =
    token != null
      ? [
          `export HIVE_CONTROL_PLANE_URL=${shSingleQuote(apiBase)}`,
          `export HIVE_AGENT_KEY=${shSingleQuote(token)}`,
          `${binHint} link`,
        ].join("\n")
      : "";

  const psBlock =
    token != null
      ? [
          `$env:HIVE_CONTROL_PLANE_URL='${psEscape(apiBase)}'`,
          `$env:HIVE_AGENT_KEY='${psEscape(token)}'`,
          `& ${binHint} link`,
        ].join("\n")
      : "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl"
        aria-labelledby="worker-instance-enroll-sheet-title"
      >
        <SheetHeader className="shrink-0 space-y-1 border-b border-border px-4 py-4 text-left">
          <SheetTitle id="worker-instance-enroll-sheet-title">Instance link enrollment</SheetTitle>
          <SheetDescription>
            <strong className="text-foreground">{droneLabel}</strong> — this mints a{" "}
            <strong className="text-foreground">one-time token</strong> for this{" "}
            <strong className="text-foreground">drone</strong> (<code className="font-mono text-[11px]">worker_instances</code>{" "}
            row). After <code className="font-mono text-[11px]">hive-worker</code> connects, runs for{" "}
            <strong className="text-foreground">every board identity</strong> bound to this instance use the same WebSocket.
            Larger blast radius than per-identity enrollment — use for shared hosts. See{" "}
            <code className="font-mono text-[11px]">doc/MANAGED-WORKER-ARCHITECTURE.md</code>.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4 pb-8 space-y-4">
            <p className="text-xs text-muted-foreground font-mono break-all">Instance id: {workerInstanceId}</p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={mint.isPending}
                onClick={() => mint.mutate()}
              >
                {mint.isPending ? "Generating…" : "Generate instance enrollment token"}
              </Button>
              <span className="text-xs text-muted-foreground">Short-lived (default ~15 minutes).</span>
            </div>

            {mint.isError && (
              <p className="text-sm text-destructive">
                {mint.error instanceof ApiError ? mint.error.message : "Could not create token."}
              </p>
            )}

            {token && expiresAt && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-50/80 dark:bg-amber-500/10 p-3 space-y-3">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  Copy now — shown once. Expires {relativeTime(new Date(expiresAt))}.
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono break-all bg-background/60 rounded px-2 py-1.5">
                  <CopyText text={token} className="text-foreground">
                    {token.slice(0, 28)}…
                  </CopyText>
                </div>
                <p className="text-xs text-muted-foreground">
                  Set env vars below, then run <code className="font-mono text-[11px]">hive-worker link</code> on the host (
                  <code className="font-mono text-[11px]">infra/worker/RELEASES.md</code>).
                </p>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">POSIX (macOS / Linux / WSL)</span>
                  <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                    <CopyText text={posixBlock} className="text-left text-foreground">
                      {posixBlock}
                    </CopyText>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">PowerShell</span>
                  <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                    <CopyText text={psBlock} className="text-left text-foreground">
                      {psBlock}
                    </CopyText>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function psEscape(s: string): string {
  return s.replace(/'/g, "''");
}
