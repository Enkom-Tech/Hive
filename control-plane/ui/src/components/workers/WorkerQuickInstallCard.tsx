import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import type { WorkerDownloadArtifact, WorkerDownloadsResponse } from "../../api/worker-downloads";
import { CopyText } from "../CopyText";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { buildInstallOneLiners } from "@/lib/worker-install-oneliners";
import { buildPosixPipeInstallOneliner, buildPowerShellPipeInstallOneliner } from "@/lib/worker-pipe-install";
import { cn } from "@/lib/utils";

export type WorkerQuickInstallCardProps = {
  title?: string;
  compact?: boolean;
  /** Anchor for in-page links (e.g. enrollment sheet “Binary install” jump). */
  sectionId?: string;
  downloads: WorkerDownloadsResponse | undefined;
  isLoading: boolean;
  suggested: WorkerDownloadArtifact | null;
};

export function WorkerQuickInstallCard({
  title = "Binary install (this host)",
  compact,
  sectionId = "worker-binary-install",
  downloads,
  isLoading,
  suggested,
}: WorkerQuickInstallCardProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const { posix, powershell } = buildInstallOneLiners(suggested, downloads?.artifacts ?? []);
  const hasArtifacts = (downloads?.artifacts?.length ?? 0) > 0;
  const blocked =
    downloads?.error && (!downloads.artifacts || downloads.artifacts.length === 0);
  const pipePosix = buildPosixPipeInstallOneliner();
  const pipePs = buildPowerShellPipeInstallOneliner();
  const showPipe = hasArtifacts && !blocked;

  return (
    <div
      id={sectionId}
      className={cn(
        "scroll-mt-4 rounded-lg border border-border bg-muted/15",
        compact ? "p-3 space-y-2" : "p-4 space-y-3",
      )}
    >
      <div>
        <h2 className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>{title}</h2>
        <p className="text-xs text-muted-foreground mt-1">
          One path for a bare VM or laptop (containers and k8s are covered in <strong className="text-foreground">Deploy hive-worker</strong>{" "}
          above). Prefer the pipe installer: it installs to <code className="font-mono text-[11px]">~/.local/bin</code> (or{" "}
          <code className="font-mono text-[11px]">%USERPROFILE%\.local\bin</code> on Windows), adds{" "}
          <code className="font-mono text-[11px]">worker</code> and <code className="font-mono text-[11px]">drone</code>{" "}
          on your PATH — open a new terminal after install. Then run enrollment from your checkout if you use the CLI.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading release URLs…
        </p>
      ) : blocked ? (
        <p className="text-xs text-destructive">
          {downloads?.error}
          {downloads?.releasesPageUrl ? (
            <>
              {" "}
              <a
                href={downloads.releasesPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 text-foreground"
              >
                Open releases page
              </a>
            </>
          ) : null}
        </p>
      ) : !hasArtifacts ? (
        <p className="text-xs text-muted-foreground">
          No worker artifacts configured. See <code className="font-mono text-[11px]">infra/worker/RELEASES.md</code>{" "}
          and <code className="font-mono text-[11px]">GET /api/worker-downloads</code>.
        </p>
      ) : (
        <div className="space-y-3">
          {showPipe ? (
            <>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Pipe install — macOS / Linux / WSL</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={pipePosix} className="text-left text-foreground">
                    {pipePosix}
                  </CopyText>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Pipe install — Windows PowerShell</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={pipePs} className="text-left text-foreground">
                    {pipePs}
                  </CopyText>
                </div>
              </div>
            </>
          ) : null}
          {(posix || powershell) && showPipe ? (
            <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
              <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-1">
                <ChevronDown
                  className={cn("h-3.5 w-3.5 shrink-0 transition-transform", manualOpen && "rotate-180")}
                />
                Manual — direct archive URL (curl / tar or Expand-Archive)
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 space-y-3 border-t border-border mt-2">
                {posix ? (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">macOS / Linux / WSL</span>
                    <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                      <CopyText text={posix} className="text-left text-foreground">
                        {posix}
                      </CopyText>
                    </div>
                  </div>
                ) : null}
                {powershell ? (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Windows PowerShell</span>
                    <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                      <CopyText text={powershell} className="text-left text-foreground">
                        {powershell}
                      </CopyText>
                    </div>
                  </div>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          ) : null}
          {showPipe && !posix && !powershell ? (
            <p className="text-xs text-muted-foreground">
              No .tar.gz or .zip in this listing for manual one-liners; pipe install still uses server-selected
              artifacts.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
