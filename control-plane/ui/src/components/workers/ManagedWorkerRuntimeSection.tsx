import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { agentsApi } from "../../api/agents";
import { ApiError } from "../../api/client";
import { CopyText } from "../CopyText";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn, relativeTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { getBoardApiBase } from "@/lib/worker-client-hints";
import { buildInstallOneLiners } from "@/lib/worker-install-oneliners";
import {
  buildPosixWorkerEnrollOneliner,
  buildPosixWorkerLinkOnlyOneliner,
  buildPowerShellWorkerEnrollOneliner,
  buildPowerShellWorkerLinkOnlyOneliner,
} from "@/lib/worker-link-snippets";
import {
  buildPosixPipeInstallOneliner,
  buildPosixPipeInstallPairOneliner,
  buildPowerShellPipeInstallOneliner,
  buildPowerShellPipeInstallPairOneliner,
} from "@/lib/worker-pipe-install";
import { WorkerDownloadPanel, useWorkerDownloadHints } from "./WorkerDownloadPanel";

type Props = {
  agentId: string;
  agentRouteId: string;
  companyId: string;
  /** e.g. "Runtime" on configure tab vs default card title */
  heading?: string;
  /** Merges onto the root card (e.g. strip border inside a sheet). */
  className?: string;
  /**
   * `enrollmentOnly`: hide global binary/pipe install (assume Workers page already showed it).
   * Keep pairing, per-identity pipe+pair, tokens, and link snippets.
   */
  variant?: "full" | "enrollmentOnly";
  /** When set with `enrollmentOnly`, replaces #worker-binary-install anchor (opens Deploy hive-worker sheet). */
  onOpenDeployHiveWorker?: () => void;
};

/**
 * Download hive-worker, mint enrollment, and link — for any managed_worker agent
 * (onboarding step, agent overview, or configuration tab).
 */
export function ManagedWorkerRuntimeSection({
  agentId,
  agentRouteId,
  companyId,
  heading = "Managed worker",
  className,
  variant = "full",
  onOpenDeployHiveWorker,
}: Props) {
  const enrollmentOnly = variant === "enrollmentOnly";
  const queryClient = useQueryClient();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualInstallOpen, setManualInstallOpen] = useState(false);
  const [freshEnrollment, setFreshEnrollment] = useState<{ token: string; expiresAt: string } | null>(null);

  const { data, isLoading: downloadsLoading, suggested, binHint } = useWorkerDownloadHints();
  const apiBase = getBoardApiBase();

  const { data: agentRow } = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId, companyId),
    enabled: Boolean(companyId && agentId),
  });
  const pairingWindowOpen =
    agentRow?.pairingWindowExpiresAt != null &&
    new Date(agentRow.pairingWindowExpiresAt).getTime() > Date.now();

  const openPairingWindow = useMutation({
    mutationFn: () => agentsApi.openWorkerPairingWindow(agentId, companyId, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.pairingRequests(companyId) });
    },
  });

  const { data: conn, isLoading: connLoading } = useQuery({
    queryKey: queryKeys.agents.workerConnection(agentId),
    queryFn: () => agentsApi.workerConnection(agentId, companyId),
    enabled: Boolean(companyId),
    refetchInterval: 5_000,
  });

  const mintEnrollment = useMutation({
    mutationFn: () => agentsApi.mintWorkerEnrollmentToken(agentId, companyId, {}),
    onSuccess: (res) => {
      if (res) setFreshEnrollment({ token: res.token, expiresAt: res.expiresAt });
    },
  });

  const connected = conn?.connected === true;
  const { posix: posixInstall, powershell: psInstall } = buildInstallOneLiners(suggested, data?.artifacts ?? []);
  const hasArtifacts = (data?.artifacts?.length ?? 0) > 0;
  const downloadsBlocked = Boolean(data?.error && (!data.artifacts || data.artifacts.length === 0));
  const showPipeInstall = hasArtifacts && !downloadsBlocked;
  const pipePosix = buildPosixPipeInstallOneliner(apiBase);
  const pipePs = buildPowerShellPipeInstallOneliner(apiBase);
  const pipePosixPair = buildPosixPipeInstallPairOneliner(apiBase, agentId);
  const pipePsPair = buildPowerShellPipeInstallPairOneliner(apiBase, agentId);
  const shellSnippetNoToken = buildPosixWorkerLinkOnlyOneliner({
    agentId,
    apiBase,
    workerBin: binHint,
  });
  const psSnippetNoToken = buildPowerShellWorkerLinkOnlyOneliner({
    agentId,
    apiBase,
    workerBin: binHint,
  });
  const shellSnippet =
    freshEnrollment?.token != null && freshEnrollment.token.length > 0
      ? buildPosixWorkerEnrollOneliner({
          agentId,
          apiBase,
          enrollmentToken: freshEnrollment.token,
          workerBin: binHint,
        })
      : "";
  const psSnippet =
    freshEnrollment?.token != null && freshEnrollment.token.length > 0
      ? buildPowerShellWorkerEnrollOneliner({
          agentId,
          apiBase,
          enrollmentToken: freshEnrollment.token,
          workerBin: binHint,
        })
      : "";

  return (
    <div className={cn("border border-border rounded-lg p-4 space-y-3 md:col-span-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs text-muted-foreground font-medium">{heading}</h4>
        <span
          className={cn(
            "text-xs font-medium rounded-full px-2 py-0.5 tabular-nums",
            connLoading
              ? "bg-muted text-muted-foreground"
              : connected
                ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
                : "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100",
          )}
        >
          {connLoading ? "Checking…" : connected ? "Connected" : "Not connected"}
        </span>
      </div>

      {enrollmentOnly ? (
        <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/15 p-3">
          Install the <code className="font-mono text-[11px]">hive-worker</code> binary on the host first (see{" "}
          {onOpenDeployHiveWorker ? (
            <button
              type="button"
              onClick={onOpenDeployHiveWorker}
              className="text-foreground font-medium underline underline-offset-2"
            >
              Binary install
            </button>
          ) : (
            <a href="#worker-binary-install" className="text-foreground font-medium underline underline-offset-2">
              Binary install
            </a>
          )}{" "}
          on the Workers page). Then use pairing, pipe+pair, or an enrollment token below so this worker process{" "}
          <strong className="text-foreground">connects as this board identity</strong> (<code className="font-mono text-[11px]">HIVE_AGENT_ID</code>{" "}
          is this row&apos;s id).
        </p>
      ) : (
        <ol className="list-decimal list-inside text-xs text-muted-foreground space-y-1.5">
          <li>
            <span className="text-foreground font-medium">Install hive-worker</span> — one line below (pipe from this
            board). Verify checksums from the releases page if your policy requires it.
          </li>
          <li>
            <span className="text-foreground font-medium">Enroll in one line</span> — from a control-plane repo checkout,
            run the copied command (sets a short-lived token and starts the worker via{" "}
            <code className="font-mono text-[11px]">pnpm hive worker link</code>
            ).
          </li>
          <li>
            <span className="text-foreground font-medium">Token</span> — generate below; shown once, consumed on first
            successful link.
          </li>
        </ol>
      )}

      <div className="space-y-2 rounded-md border border-sky-500/25 bg-sky-500/5 dark:bg-sky-950/20 p-3">
        <p className="text-xs font-medium text-foreground">Push pairing (no enrollment copy/paste)</p>
        <p className="text-xs text-muted-foreground">
          Open a short pairing window, then on the host run{" "}
          <code className="font-mono text-[11px]">
            ./hive-worker pair -agent-id {agentId}
          </code>{" "}
          (or set <code className="font-mono text-[11px]">HIVE_PAIRING=1</code> with{" "}
          <code className="font-mono text-[11px]">HIVE_CONTROL_PLANE_URL</code> and{" "}
          <code className="font-mono text-[11px]">HIVE_AGENT_ID</code>). You will get an in-app toast; approve the
          request here or on <strong className="text-foreground">Workers</strong>.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            size="sm"
            variant={pairingWindowOpen ? "secondary" : "default"}
            disabled={openPairingWindow.isPending}
            onClick={() => openPairingWindow.mutate()}
          >
            {openPairingWindow.isPending
              ? "Opening…"
              : pairingWindowOpen
                ? "Extend pairing window"
                : "Open pairing window (~15 min)"}
          </Button>
          {agentRow?.pairingWindowExpiresAt && pairingWindowOpen ? (
            <span className="text-xs text-muted-foreground">
              Window expires {relativeTime(new Date(agentRow.pairingWindowExpiresAt))}
            </span>
          ) : null}
        </div>
        {openPairingWindow.isError && (
          <p className="text-xs text-destructive">
            {openPairingWindow.error instanceof ApiError
              ? openPairingWindow.error.message
              : "Could not open pairing window."}
          </p>
        )}
      </div>

      {enrollmentOnly && !downloadsLoading && showPipeInstall ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
          <p className="text-xs font-medium text-foreground">Pipe + pair (this identity)</p>
          <p className="text-xs text-muted-foreground">
            With the pairing window open: one line installs <code className="font-mono text-[11px]">hive-worker</code> and runs native pairing. This board identity&apos;s id is embedded in the URL.
          </p>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">macOS / Linux / WSL</span>
            <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
              <CopyText text={pipePosixPair} className="text-left text-foreground">
                {pipePosixPair}
              </CopyText>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Windows PowerShell</span>
            <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
              <CopyText text={pipePsPair} className="text-left text-foreground">
                {pipePsPair}
              </CopyText>
            </div>
          </div>
        </div>
      ) : null}

      {enrollmentOnly && !downloadsLoading && !showPipeInstall ? (
        <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/10 p-3">
          {data?.error
            ? String(data.error)
            : "Configure worker release artifacts to enable pipe+pair."}{" "}
          {data?.releasesPageUrl ? (
            <a
              href={data.releasesPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 text-foreground"
            >
              Releases
            </a>
          ) : null}
        </p>
      ) : null}

      {!enrollmentOnly ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
          <p className="text-xs font-medium text-foreground">Quick install (this host)</p>
          <p className="text-xs text-muted-foreground">
            Pipe installer loads the same artifacts as <code className="font-mono text-[11px]">GET /api/worker-downloads</code>
            . By default it installs to <code className="font-mono text-[11px]">~/.local/bin</code> (or Windows{" "}
            <code className="font-mono text-[11px]">.local\bin</code>) and puts <code className="font-mono text-[11px]">hive-worker</code>,{" "}
            <code className="font-mono text-[11px]">worker</code>, and <code className="font-mono text-[11px]">drone</code> on your PATH — open a new shell after install. Run enrollment from your checkout if you use <code className="font-mono text-[11px]">pnpm hive worker link</code>.
          </p>
          {!downloadsLoading && showPipeInstall ? (
            <>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Pipe — macOS / Linux / WSL</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={pipePosix} className="text-left text-foreground">
                    {pipePosix}
                  </CopyText>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Pipe — Windows PowerShell</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={pipePs} className="text-left text-foreground">
                    {pipePs}
                  </CopyText>
                </div>
              </div>
              <p className="text-xs text-muted-foreground pt-1">
                <span className="font-medium text-foreground">Pipe + pair</span> — with the pairing window open, one line
                downloads the binary and runs native pairing (no Node). Agent id is embedded in the URL.
              </p>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Pipe + pair — macOS / Linux / WSL</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={pipePosixPair} className="text-left text-foreground">
                    {pipePosixPair}
                  </CopyText>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Pipe + pair — Windows PowerShell</span>
                <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                  <CopyText text={pipePsPair} className="text-left text-foreground">
                    {pipePsPair}
                  </CopyText>
                </div>
              </div>
            </>
          ) : !downloadsLoading ? (
            <p className="text-xs text-muted-foreground">
              {data?.error
                ? String(data.error)
                : "Configure worker release artifacts to enable pipe install."}{" "}
              {data?.releasesPageUrl ? (
                <a
                  href={data.releasesPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 text-foreground"
                >
                  Releases
                </a>
              ) : null}
            </p>
          ) : null}
          {!downloadsLoading && (posixInstall || psInstall) && showPipeInstall ? (
            <Collapsible open={manualInstallOpen} onOpenChange={setManualInstallOpen}>
              <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-1">
                <ChevronDown
                  className={cn("h-3.5 w-3.5 shrink-0 transition-transform", manualInstallOpen && "rotate-180")}
                />
                Manual — direct archive URL
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 space-y-2 border-t border-border mt-2">
                {posixInstall ? (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">macOS / Linux / WSL</span>
                    <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                      <CopyText text={posixInstall} className="text-left text-foreground">
                        {posixInstall}
                      </CopyText>
                    </div>
                  </div>
                ) : null}
                {psInstall ? (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Windows PowerShell</span>
                    <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
                      <CopyText text={psInstall} className="text-left text-foreground">
                        {psInstall}
                      </CopyText>
                    </div>
                  </div>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      ) : null}

      {!enrollmentOnly ? (
        <WorkerDownloadPanel downloads={data} isLoading={downloadsLoading} suggested={suggested} />
      ) : null}

      {!freshEnrollment && !connected ? (
        <div className="space-y-2 rounded-md border border-dashed border-border bg-muted/10 p-3">
          <p className="text-xs font-medium text-foreground">Link (before enrollment token)</p>
          <p className="text-xs text-muted-foreground">
            Run from the repo root. Set <code className="font-mono text-[11px]">HIVE_WORKER_ENROLLMENT_TOKEN</code> after
            you generate a token below, or use an API key (Advanced).
          </p>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">POSIX shell</span>
            <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
              <CopyText text={shellSnippetNoToken} className="text-left text-foreground">
                {shellSnippetNoToken}
              </CopyText>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">PowerShell</span>
            <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
              <CopyText text={psSnippetNoToken} className="text-left text-foreground">
                {psSnippetNoToken}
              </CopyText>
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {enrollmentOnly ? (
          <>
            Runs and heartbeats for this <strong className="text-foreground">board identity</strong> go to the connected{" "}
            <strong className="text-foreground">drone</strong> over WebSocket. Prefer a{" "}
            <span className="font-medium text-foreground">short-lived enrollment token</span> over long-lived API keys in scripts.
          </>
        ) : (
          <>
            Runs and heartbeats are delivered to the drone over WebSocket for this agent identity. Prefer a{" "}
            <span className="font-medium text-foreground">short-lived enrollment token</span> over embedding long-lived API
            keys in scripts.
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={mintEnrollment.isPending}
          onClick={() => mintEnrollment.mutate()}
        >
          {mintEnrollment.isPending ? "Generating…" : "Generate enrollment token"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Short-lived (default ~15 minutes server-side); paste the one-liner immediately.
        </span>
      </div>
      {mintEnrollment.isError && (
        <p className="text-sm text-destructive">
          {mintEnrollment.error instanceof ApiError
            ? mintEnrollment.error.message
            : "Could not create enrollment token."}
        </p>
      )}
      {freshEnrollment && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-50/80 dark:bg-amber-500/10 p-3 space-y-2">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Copy now — this secret is shown once. Expires {relativeTime(new Date(freshEnrollment.expiresAt))}.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono break-all bg-background/60 rounded px-2 py-1.5">
            <CopyText text={freshEnrollment.token} className="text-foreground">
              {freshEnrollment.token.slice(0, 24)}…
            </CopyText>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">POSIX shell</span>
            <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
              <CopyText text={shellSnippet} className="text-left text-foreground">
                {shellSnippet}
              </CopyText>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">PowerShell</span>
            <div className="rounded-md bg-muted/50 p-2 text-xs font-mono whitespace-pre-wrap break-all">
              <CopyText text={psSnippet} className="text-left text-foreground">
                {psSnippet}
              </CopyText>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground h-8" onClick={() => setFreshEnrollment(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-1">
          <ChevronDown
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform", advancedOpen && "rotate-180")}
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 text-xs text-muted-foreground space-y-2 border-t border-border mt-2">
          <p>
            Long-lived{" "}
            <Link
              to={`/agents/${agentRouteId}/configure`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              API keys
            </Link>{" "}
            work with <code className="font-mono">HIVE_AGENT_KEY</code> or <code className="font-mono">--agent-key</code>
            . The worker uses an outbound WebSocket; see <code className="font-mono">doc/MANAGED-WORKER-ARCHITECTURE.md</code>{" "}
            and <code className="font-mono">infra/worker/RELEASES.md</code>.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
