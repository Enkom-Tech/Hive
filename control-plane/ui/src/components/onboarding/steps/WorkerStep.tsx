import { useState, useMemo } from "react";
import { ChevronDown, Loader2, Radio, CheckCircle2, AlertCircle, HelpCircle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { agentsApi } from "../../../api/agents";
import { ApiError } from "../../../api/client";
import { CopyText } from "../../CopyText";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, relativeTime } from "@/lib/utils";
import { useAgentWorkerStatus } from "../../../hooks/useAgentWorkerStatus";
import { getBoardApiBase } from "@/lib/worker-client-hints";
import {
  buildPosixWorkerEnrollOneliner,
  buildPosixWorkerLinkOnlyOneliner,
  buildPowerShellWorkerEnrollOneliner,
  buildPowerShellWorkerLinkOnlyOneliner,
} from "@/lib/worker-link-snippets";
import { WorkerDownloadPanel, useWorkerDownloadHints } from "../../workers/WorkerDownloadPanel";
import { WorkerQuickInstallCard } from "../../workers/WorkerQuickInstallCard";

type WorkerStepProps = {
  companyId: string;
  agentId: string | null;
  ensuringAgent: boolean;
  ensureError: string | null;
  enrollmentToken: string | null;
  enrollmentExpiresAt: string | null;
  onEnrollmentResult: (token: string | null, expiresAt: string | null) => void;
  workerSkipped: boolean;
};

function detectPlatform(): "macos-linux" | "windows" | "unknown" {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("win")) return "windows";
  if (userAgent.includes("mac") || userAgent.includes("linux")) return "macos-linux";
  return "unknown";
}

export function WorkerStep({
  companyId,
  agentId,
  ensuringAgent,
  ensureError,
  enrollmentToken,
  enrollmentExpiresAt,
  onEnrollmentResult,
  workerSkipped,
}: WorkerStepProps) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showEnrollment, setShowEnrollment] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);
  
  const { data: conn, isLoading: connLoading } = useAgentWorkerStatus(agentId, companyId, {
    enabled: Boolean(agentId && companyId) && !workerSkipped,
  });
  const connected = conn?.connected === true;

  const apiBase = getBoardApiBase();
  const { data: downloads, isLoading: downloadsLoading, suggested, binHint } = useWorkerDownloadHints();

  const mintEnrollment = useMutation({
    mutationFn: () => agentsApi.mintWorkerEnrollmentToken(agentId!, companyId, {}),
    onSuccess: (res) => {
      onEnrollmentResult(res.token, res.expiresAt);
    },
  });

  const shellSnippet =
    enrollmentToken && agentId
      ? buildPosixWorkerEnrollOneliner({ agentId, apiBase, enrollmentToken, workerBin: binHint })
      : agentId
        ? buildPosixWorkerLinkOnlyOneliner({ agentId, apiBase, workerBin: binHint })
        : "";

  const psSnippet =
    enrollmentToken && agentId
      ? buildPowerShellWorkerEnrollOneliner({ agentId, apiBase, enrollmentToken, workerBin: binHint })
      : agentId
        ? buildPowerShellWorkerLinkOnlyOneliner({ agentId, apiBase, workerBin: binHint })
        : "";

  const primarySnippet = platform === "windows" ? psSnippet : shellSnippet;
  const alternativeSnippet = platform === "windows" ? shellSnippet : psSnippet;
  const primaryLabel = platform === "windows" ? "Windows (PowerShell)" : "macOS / Linux";
  const alternativeLabel = platform === "windows" ? "macOS / Linux" : "Windows (PowerShell)";

  if (ensuringAgent) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin opacity-60" />
        <p>Preparing your COO agent so the worker can enroll…</p>
      </div>
    );
  }

  if (ensureError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{ensureError}</p>
        <p className="text-xs text-muted-foreground">Go back and check your company details, then try again.</p>
      </div>
    );
  }

  if (!agentId) {
    return <p className="text-sm text-muted-foreground">Complete the previous step first.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="bg-muted/50 p-2">
          <Radio className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-medium">
            Connect a{" "}
            <Tooltip>
              <TooltipTrigger className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 cursor-help">
                worker
                <HelpCircle className="h-3 w-3" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p>A worker runs on your machine and executes tasks assigned by your agents.</p>
              </TooltipContent>
            </Tooltip>
          </h3>
          <p className="text-xs text-muted-foreground">
            Workers execute tasks on your machines. Install the worker binary, then it will connect automatically.
          </p>
        </div>
      </div>

      {/* Connection Status - Prominent */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-3 text-sm",
          connLoading
            ? "border-border bg-muted/30 text-muted-foreground"
            : connected
              ? "border-green-500/40 bg-green-500/5 text-green-800 dark:text-green-200"
              : "border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-100"
        )}
      >
        {connLoading ? (
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        ) : connected ? (
          <CheckCircle2 className="h-4 w-4 shrink-0" />
        ) : (
          <AlertCircle className="h-4 w-4 shrink-0" />
        )}
        <span className="font-medium">
          {workerSkipped
            ? "Skipped for now"
            : connLoading
              ? "Checking connection…"
              : connected
                ? "Worker connected"
                : "Waiting for worker to connect…"}
        </span>
      </div>

      {/* Primary Install Method */}
      <div className="rounded-lg border border-border bg-muted/15 p-4 space-y-3">
        <div>
          <h4 className="text-sm font-medium">Quick install — {primaryLabel}</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Copy and run this in your terminal. The installer will set up the worker and add it to your PATH.
          </p>
        </div>
        
        <WorkerQuickInstallCard
          title=""
          compact
          downloads={downloads}
          isLoading={downloadsLoading}
          suggested={suggested}
        />
      </div>

      {/* Alternative Methods - Collapsed */}
      <Collapsible open={showAlternatives} onOpenChange={setShowAlternatives}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-1">
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", showAlternatives && "rotate-180")} />
          Other install options ({alternativeLabel}, Docker, manual download)
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-4 border-t border-border mt-2">
          <WorkerDownloadPanel downloads={downloads} isLoading={downloadsLoading} suggested={suggested} />
        </CollapsibleContent>
      </Collapsible>

      {/* Enrollment Token - Collapsed */}
      <Collapsible open={showEnrollment} onOpenChange={setShowEnrollment}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-1">
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", showEnrollment && "rotate-180")} />
          Use enrollment token (advanced)
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-3 border-t border-border mt-2">
          <p className="text-xs text-muted-foreground">
            Enrollment tokens are useful for automated setups or when pairing workers without running install commands.
          </p>
          
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={mintEnrollment.isPending || workerSkipped}
            onClick={() => mintEnrollment.mutate()}
          >
            {mintEnrollment.isPending ? "Generating…" : "Generate enrollment token"}
          </Button>
          
          {mintEnrollment.isError && (
            <p className="text-xs text-destructive">
              {mintEnrollment.error instanceof ApiError
                ? mintEnrollment.error.message
                : "Could not create enrollment token."}
            </p>
          )}

          {enrollmentToken && enrollmentExpiresAt && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-50/80 dark:bg-amber-500/10 p-3 space-y-2">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Copy now — this secret is shown once. Expires {relativeTime(new Date(enrollmentExpiresAt))}.
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono break-all bg-background/60 rounded px-2 py-1.5">
                <CopyText text={enrollmentToken} className="text-foreground">
                  {enrollmentToken.slice(0, 24)}…
                </CopyText>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{primaryLabel}</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={primarySnippet} className="text-left text-foreground">
                    {primarySnippet}
                  </CopyText>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{alternativeLabel}</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={alternativeSnippet} className="text-left text-foreground">
                    {alternativeSnippet}
                  </CopyText>
                </div>
              </div>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default function WorkerStepWithProvider(props: WorkerStepProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <WorkerStep {...props} />
    </TooltipProvider>
  );
}
