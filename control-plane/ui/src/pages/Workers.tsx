import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  workersApi,
  type BoardAgentOverviewRow,
  type DroneInstanceOverview,
  type WorkerPairingRequestRow,
} from "../api/workers";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef, cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { WorkerEnrollSheet } from "../components/workers/WorkerEnrollSheet";
import { WorkerInstanceEnrollSheet } from "../components/workers/WorkerInstanceEnrollSheet";
import { WorkerDeployHiveWorkerSheet } from "../components/workers/WorkerDeployHiveWorkerSheet";
import { WorkerAttachIdentityDialog } from "../components/workers/WorkerAttachIdentityDialog";
import { useWorkerDownloadHints } from "../components/workers/WorkerDownloadPanel";
import { getBoardApiBase } from "@/lib/worker-client-hints";
import { ApiError } from "../api/client";
import { Cpu, RefreshCw } from "lucide-react";

type EnrollTarget = {
  agentId: string;
  agentRouteId: string;
  agentName: string;
};

function droneHost(a: BoardAgentOverviewRow): string {
  return a.drone?.hostname ?? "—";
}

function droneVersion(a: BoardAgentOverviewRow): string {
  return a.drone?.version ?? "—";
}

function droneHello(a: BoardAgentOverviewRow): string {
  return a.drone?.lastHelloAt ? relativeTime(new Date(a.drone.lastHelloAt)) : "—";
}

const HEALTHY_RECENCY_MS = 90_000;
const FLAKY_RECENCY_MS = 5 * 60_000;

type SocketState = "open" | "closed";
type LivenessState = "healthy" | "flaky" | "offline";

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function latestSignalDate(dates: Array<Date | null>): Date | null {
  let latest: Date | null = null;
  for (const current of dates) {
    if (!current) continue;
    if (!latest || current.getTime() > latest.getTime()) latest = current;
  }
  return latest;
}

function classifyLiveness(socketState: SocketState, latestSignal: Date | null): LivenessState {
  const ageMs = latestSignal ? Date.now() - latestSignal.getTime() : Number.POSITIVE_INFINITY;
  if (socketState === "open" && ageMs <= HEALTHY_RECENCY_MS) return "healthy";
  if (ageMs <= FLAKY_RECENCY_MS || socketState === "open") return "flaky";
  return "offline";
}

/** Drone row: open WebSocket on this node means the process is live; DB hello/seen can lag without a new `hello`. */
function classifyDroneLiveness(socketState: SocketState, latestSignal: Date | null): LivenessState {
  if (socketState === "open") return "healthy";
  return classifyLiveness("closed", latestSignal);
}

function livenessBadgeClass(state: LivenessState): string {
  if (state === "healthy") return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200";
  if (state === "flaky") return "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100";
  return "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100";
}

function socketBadgeClass(state: SocketState): string {
  return state === "open"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100";
}

function linkageBadge(total: number, linked: number): { label: string; className: string } {
  if (total === 0) {
    return {
      label: "No identities attached",
      className: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
    };
  }
  if (linked === total) {
    return {
      label: "Fully linked",
      className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
    };
  }
  if (linked > 0) {
    return {
      label: "Partially linked",
      className: "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100",
    };
  }
  return {
    label: "Attached, not linked",
    className: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
  };
}

function dronePlacementSummary(inst: DroneInstanceOverview): string | null {
  const parts: string[] = [];
  if (inst.labels && Object.keys(inst.labels).length > 0) {
    parts.push(`Labels ${JSON.stringify(inst.labels)}`);
  }
  if (inst.drainRequestedAt) {
    parts.push(`Drain requested ${relativeTime(new Date(inst.drainRequestedAt))}`);
  }
  if (inst.capacityHint?.trim()) {
    parts.push(`Capacity ${inst.capacityHint.trim()}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function Workers() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const downloadHints = useWorkerDownloadHints();

  const [enrollSheetOpen, setEnrollSheetOpen] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<EnrollTarget | null>(null);
  const [enrollLinkUnknown, setEnrollLinkUnknown] = useState(false);
  const [instanceEnrollTarget, setInstanceEnrollTarget] = useState<{
    workerInstanceId: string;
    droneLabel: string;
  } | null>(null);
  const [attachIdentityTarget, setAttachIdentityTarget] = useState<{
    workerInstanceId: string;
    droneLabel: string;
  } | null>(null);
  const [deploySheetOpen, setDeploySheetOpen] = useState(false);
  const enrollCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiBase = getBoardApiBase();

  const openDeployHiveWorker = useCallback(() => {
    setDeploySheetOpen(true);
  }, []);

  const openDeployHiveWorkerAndCloseEnroll = useCallback(() => {
    if (enrollCloseTimerRef.current) {
      clearTimeout(enrollCloseTimerRef.current);
      enrollCloseTimerRef.current = null;
    }
    setDeploySheetOpen(true);
    setEnrollSheetOpen(false);
    setEnrollTarget(null);
  }, []);

  const openEnrollFor = useCallback((target: EnrollTarget) => {
    if (enrollCloseTimerRef.current) {
      clearTimeout(enrollCloseTimerRef.current);
      enrollCloseTimerRef.current = null;
    }
    setEnrollTarget(target);
    setEnrollSheetOpen(true);
    setEnrollLinkUnknown(false);
  }, []);

  const onEnrollSheetOpenChange = useCallback((open: boolean) => {
    if (enrollCloseTimerRef.current) {
      clearTimeout(enrollCloseTimerRef.current);
      enrollCloseTimerRef.current = null;
    }
    setEnrollSheetOpen(open);
    if (!open) {
      enrollCloseTimerRef.current = setTimeout(() => {
        setEnrollTarget(null);
        enrollCloseTimerRef.current = null;
      }, 320);
    }
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workers" }]);
  }, [setBreadcrumbs]);

  useEffect(
    () => () => {
      if (enrollCloseTimerRef.current) {
        clearTimeout(enrollCloseTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (location.hash === "#worker-binary-install") {
      setDeploySheetOpen(true);
      navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.workers.overview(selectedCompanyId!),
    queryFn: () => workersApi.overview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    staleTime: 10_000,
    refetchInterval: 12_000,
  });

  const { data: pairingData } = useQuery({
    queryKey: queryKeys.workers.pairingRequests(selectedCompanyId!),
    queryFn: () => workersApi.listPairingRequests(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 12_000,
  });

  const enrollParam = searchParams.get("enroll");
  useEffect(() => {
    if (!enrollParam) {
      setEnrollLinkUnknown(false);
      return;
    }
    if (isLoading || error || !data?.boardAgents) {
      return;
    }
    const row = data.boardAgents.find((a) => a.agentId === enrollParam);
    navigate({ pathname: location.pathname, search: "" }, { replace: true });
    if (row) {
      const routeRef = agentRouteRef({ id: row.agentId, urlKey: row.urlKey, name: row.name });
      openEnrollFor({ agentId: row.agentId, agentRouteId: routeRef, agentName: row.name });
    } else {
      setEnrollLinkUnknown(true);
      setEnrollSheetOpen(false);
      setEnrollTarget(null);
    }
  }, [enrollParam, isLoading, error, data?.boardAgents, navigate, location.pathname, openEnrollFor]);

  const approvePairing = useMutation({
    mutationFn: (r: WorkerPairingRequestRow) =>
      workersApi.approvePairingRequest(r.agentId, r.id, selectedCompanyId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.pairingRequests(selectedCompanyId!) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(selectedCompanyId!) });
    },
  });

  const rejectPairing = useMutation({
    mutationFn: (r: WorkerPairingRequestRow) =>
      workersApi.rejectPairingRequest(r.agentId, r.id, selectedCompanyId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.pairingRequests(selectedCompanyId!) });
    },
  });

  const deleteWorkerInstance = useMutation({
    mutationFn: (workerInstanceId: string) =>
      workersApi.deleteWorkerInstance(selectedCompanyId!, workerInstanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(selectedCompanyId!) });
    },
  });

  const rotateWorkerPool = useMutation({
    mutationFn: (agentId: string) =>
      workersApi.rotateAutomaticWorkerPool(selectedCompanyId!, agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(selectedCompanyId!) });
    },
  });

  const patchWorkerInstance = useMutation({
    mutationFn: (args: { workerInstanceId: string; body: { drainRequested: boolean } }) =>
      workersApi.patchWorkerInstance(selectedCompanyId!, args.workerInstanceId, args.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(selectedCompanyId!) });
    },
  });

  const summary = useMemo(() => {
    const agents = data?.boardAgents ?? [];
    const connected = agents.filter((a) => a.connected).length;
    const pendingTokens = agents.reduce((s, a) => s + a.pendingEnrollmentCount, 0);
    const pendingPairing = pairingData?.requests?.length ?? 0;
    const drones = data?.instances?.length ?? 0;
    return {
      total: agents.length,
      connected,
      disconnected: agents.length - connected,
      pendingTokens,
      pendingPairing,
      drones,
    };
  }, [data?.boardAgents, data?.instances?.length, pairingData?.requests?.length]);

  const hasOverviewRows = useMemo(() => {
    if (!data) return false;
    return (data.instances?.length ?? 0) > 0 || (data.boardAgents?.length ?? 0) > 0;
  }, [data]);

  const renderAgentRows = (rows: BoardAgentOverviewRow[]) =>
    rows.map((row) => {
      const routeRef = agentRouteRef({ id: row.agentId, urlKey: row.urlKey, name: row.name });
      const target: EnrollTarget = {
        agentId: row.agentId,
        agentRouteId: routeRef,
        agentName: row.name,
      };
      const sheetActive = enrollSheetOpen && enrollTarget?.agentId === row.agentId;
      const identitySocketState: SocketState = row.connected ? "open" : "closed";
      const identityLastHeartbeat = parseIsoDate(row.lastHeartbeatAt);
      const identityLiveness = classifyLiveness(identitySocketState, identityLastHeartbeat);
      return (
        <tr key={row.agentId} className="border-b border-border align-top">
          <td className="px-3 py-2 pl-6">
            <Link
              to={`/agents/${routeRef}/overview`}
              className="font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              {row.name}
            </Link>
            <div className="text-xs text-muted-foreground font-mono">{routeRef}</div>
          </td>
          <td className="px-3 py-2 text-muted-foreground capitalize">{row.status}</td>
          <td className="px-3 py-2 text-muted-foreground text-xs">
            <span className="font-mono">{row.workerPlacementMode}</span>
            {row.assignmentSource ? (
              <span className="text-muted-foreground/80"> · {row.assignmentSource}</span>
            ) : null}
          </td>
          <td className="px-3 py-2 text-muted-foreground text-xs capitalize">{row.operationalPosture}</td>
          <td className="px-3 py-2">
            <span
              className={cn(
                "text-xs font-medium rounded-full px-2 py-0.5 tabular-nums",
                socketBadgeClass(identitySocketState),
              )}
              title="Node-local socket state for this identity link"
            >
              {identitySocketState === "open" ? "Socket open (this node)" : "Socket closed"}
            </span>
          </td>
          <td className="px-3 py-2 text-muted-foreground text-xs">{droneHost(row)}</td>
          <td className="px-3 py-2 text-muted-foreground text-xs font-mono">{droneVersion(row)}</td>
          <td className="px-3 py-2 text-muted-foreground text-xs">{droneHello(row)}</td>
          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{row.pendingEnrollmentCount}</td>
          <td className="px-3 py-2 text-muted-foreground text-xs">
            <div className="flex flex-col items-start gap-1">
              <span
                className={cn(
                  "text-[11px] font-medium rounded-full px-2 py-0.5 tabular-nums",
                  livenessBadgeClass(identityLiveness),
                )}
                title="Derived from socket state + heartbeat recency"
              >
                {identityLiveness === "healthy" ? "Healthy" : identityLiveness === "flaky" ? "Flaky" : "Offline"}
              </span>
              <span>{row.lastHeartbeatAt ? relativeTime(row.lastHeartbeatAt) : "—"}</span>
            </div>
          </td>
          <td className="px-3 py-2">
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-8 text-xs w-full sm:w-auto"
                aria-expanded={sheetActive}
                title="Connect hive-worker on a host to this board identity (pairing, token, or pipe)"
                aria-label={`Assign board identity ${row.name} to a drone worker process`}
                onClick={() => openEnrollFor(target)}
              >
                Assign to drone
              </Button>
              {row.workerPlacementMode === "automatic" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs w-full sm:w-auto gap-1"
                  disabled={rotateWorkerPool.isPending && rotateWorkerPool.variables === row.agentId}
                  title="Advance to the next eligible drone in the pool (same rules as automatic placement)"
                  aria-label={`Rotate automatic pool for ${row.name}`}
                  onClick={() => rotateWorkerPool.mutate(row.agentId)}
                >
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Rotate pool
                </Button>
              ) : null}
              <Button variant="outline" size="sm" className="h-8 text-xs w-full sm:w-auto" asChild>
                <Link to={`/agents/${routeRef}/configure`}>Configure</Link>
              </Button>
            </div>
          </td>
        </tr>
      );
    });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company to view workers.</p>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {enrollTarget && selectedCompanyId ? (
        <WorkerEnrollSheet
          open={enrollSheetOpen}
          onOpenChange={onEnrollSheetOpenChange}
          agentId={enrollTarget.agentId}
          agentRouteId={enrollTarget.agentRouteId}
          companyId={selectedCompanyId}
          agentName={enrollTarget.agentName}
          onOpenDeployHiveWorker={openDeployHiveWorkerAndCloseEnroll}
        />
      ) : null}

      <WorkerDeployHiveWorkerSheet
        open={deploySheetOpen}
        onOpenChange={setDeploySheetOpen}
        companyId={selectedCompanyId}
        apiBase={apiBase}
        workerBinHint={downloadHints.binHint || "hive-worker"}
        downloads={downloadHints.data}
        isLoading={downloadHints.isLoading}
        suggested={downloadHints.suggested}
      />

      {instanceEnrollTarget && selectedCompanyId ? (
        <WorkerInstanceEnrollSheet
          open
          onOpenChange={(open) => {
            if (!open) setInstanceEnrollTarget(null);
          }}
          companyId={selectedCompanyId}
          workerInstanceId={instanceEnrollTarget.workerInstanceId}
          droneLabel={instanceEnrollTarget.droneLabel}
        />
      ) : null}

      {attachIdentityTarget && selectedCompanyId && data ? (
        <WorkerAttachIdentityDialog
          open
          onOpenChange={(open) => {
            if (!open) setAttachIdentityTarget(null);
          }}
          companyId={selectedCompanyId}
          workerInstanceId={attachIdentityTarget.workerInstanceId}
          droneLabel={attachIdentityTarget.droneLabel}
          candidates={data.unassignedBoardAgents}
        />
      ) : null}

      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Workers</h1>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={openDeployHiveWorker}>
            Install or deploy hive-worker
          </Button>
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          <strong className="text-foreground font-medium">Fleet first:</strong> enroll <strong className="text-foreground font-medium">drones</strong> (hosts running{" "}
          <code className="font-mono text-xs">hive-worker</code>); they appear after connect and <code className="font-mono text-[11px]">hello</code>.{" "}
          <strong className="text-foreground font-medium">Board identities</strong> (<code className="font-mono text-xs">managed_worker</code>) are who receives work —{" "}
          <strong className="text-foreground font-medium">assignment</strong> (manual pin or automatic pool) is explicit; hello does not bind identities. Use{" "}
          <strong className="text-foreground font-medium">Assign to drone</strong> or <strong className="text-foreground font-medium">Attach identity</strong>. Install
          the binary from{" "}
          <button
            type="button"
            onClick={openDeployHiveWorker}
            className="text-foreground font-medium underline underline-offset-2"
          >
            Install or deploy hive-worker
          </button>{" "}
          (binary, container notes, drone-first). Need another identity?{" "}
          <Link to="/agents/new" className="text-blue-600 hover:underline dark:text-blue-400">
            Add agent
          </Link>
          . Read status as: <strong className="text-foreground font-medium">Socket</strong> (transport right now),{" "}
          <strong className="text-foreground font-medium">Liveness</strong> (recency confidence), and{" "}
          <strong className="text-foreground font-medium">Linkage</strong> (how many attached identities are active).
        </p>
      </div>

      {enrollLinkUnknown ? (
        <div
          className="rounded-lg border border-amber-500/35 bg-amber-500/5 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-950 dark:text-amber-100"
          role="status"
        >
          This link referred to a board identity that isn&apos;t in this company&apos;s list (wrong company, removed
          agent, or expired bookmark). Open <strong className="font-medium">Assign to drone</strong> from a row below.
        </div>
      ) : null}

      {pairingData && pairingData.requests.length > 0 ? (
        <div
          className="rounded-lg border border-sky-500/30 bg-sky-500/5 dark:bg-sky-950/25 p-4 space-y-3"
          role="region"
          aria-label="Pending drone pairing requests"
        >
          <h2 className="text-sm font-medium text-foreground">Pending drone pairing</h2>
          <p className="text-xs text-muted-foreground">
            A host ran pairing while a window was open. Approve to mint a one-time enrollment for that request.
          </p>
          <ul className="space-y-3">
            {pairingData.requests.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{r.agentName}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">
                    {r.id} · {r.requestIp}
                  </div>
                  {typeof r.clientInfo?.hostname === "string" ? (
                    <div className="text-xs text-muted-foreground">Host: {r.clientInfo.hostname}</div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">Expires {relativeTime(new Date(r.expiresAt))}</div>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    disabled={approvePairing.isPending || rejectPairing.isPending}
                    onClick={() => approvePairing.mutate(r)}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={approvePairing.isPending || rejectPairing.isPending}
                    onClick={() => rejectPairing.mutate(r)}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div
        className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
        role="note"
      >
        <strong className="text-foreground font-medium">Interpretation:</strong> Socket badges are node-local
        WebSocket truth; Liveness is derived from socket + recency. In multi-instance deployments, a socket can be open
        on one API node while closed on another. See <code className="font-mono text-[11px]">docs/api/workers.md</code>{" "}
        (API Reference → Workers).
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-destructive">
            {error instanceof ApiError ? error.message : "Could not load workers overview."}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isFetching && "animate-spin")} />
            Retry
          </Button>
        </div>
      )}

      {!error && !isLoading && (summary.total > 0 || summary.drones > 0) && (
        <div className="flex flex-wrap gap-2">
          {summary.total > 0 ? (
            <span className="text-xs font-medium rounded-full px-2.5 py-1 bg-muted text-muted-foreground tabular-nums">
              {summary.total} board identit{summary.total === 1 ? "y" : "ies"}
            </span>
          ) : null}
          {summary.drones > 0 ? (
            <span className="text-xs font-medium rounded-full px-2.5 py-1 bg-muted text-muted-foreground tabular-nums">
              {summary.drones} enrolled drone{summary.drones === 1 ? "" : "s"}
            </span>
          ) : null}
          {summary.total > 0 ? (
            <>
              <span className="text-xs font-medium rounded-full px-2.5 py-1 bg-green-500/10 text-green-800 dark:text-green-200 tabular-nums">
                {summary.connected} identity link{summary.connected === 1 ? "" : "s"} connected
              </span>
              <span className="text-xs font-medium rounded-full px-2.5 py-1 bg-amber-500/10 text-amber-900 dark:text-amber-100 tabular-nums">
                {summary.disconnected} not connected
              </span>
            </>
          ) : null}
          {summary.pendingTokens > 0 ? (
            <span className="text-xs font-medium rounded-full px-2.5 py-1 bg-blue-500/10 text-blue-800 dark:text-blue-200 tabular-nums">
              {summary.pendingTokens} pending enrollment token{summary.pendingTokens === 1 ? "" : "s"}
            </span>
          ) : null}
          {summary.pendingPairing > 0 ? (
            <span className="text-xs font-medium rounded-full px-2.5 py-1 bg-sky-500/15 text-sky-900 dark:text-sky-100 tabular-nums">
              {summary.pendingPairing} pairing request{summary.pendingPairing === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading drones and identities…</p>
      ) : !error && !hasOverviewRows ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-4">
          <div className="bg-muted/50 p-4 rounded-md inline-flex">
            <Cpu className="h-10 w-10 text-muted-foreground/60" />
          </div>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            No managed identities yet. Onboarding creates a COO agent automatically; you can also add one from the agent
            directory.
          </p>
          <Button asChild variant="default">
            <Link to="/agents/new">Add agent</Link>
          </Button>
          <p className="text-xs text-muted-foreground max-w-md mx-auto pt-2">
            To run <code className="font-mono text-[11px]">hive-worker</code> without an identity yet, open{" "}
            <button
              type="button"
              onClick={openDeployHiveWorker}
              className="text-foreground font-medium underline underline-offset-2"
            >
              Install or deploy hive-worker
            </button>{" "}
            for pipe install and drone-first bootstrap.
          </p>
        </div>
      ) : !error && data ? (
        <div className="border border-border rounded-lg overflow-x-auto">
          <p className="text-xs text-muted-foreground mb-2 px-0.5">
            Each <strong className="text-foreground font-medium">Drone</strong> row is an enrolled host process (socket
            state is in the header); nested rows are <strong className="text-foreground font-medium">board identities</strong>{" "}
            bound to that host.
          </p>
          <table className="w-full text-sm min-w-[980px]">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left">
                <th className="px-3 py-2 font-medium text-muted-foreground">Board identity</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Identity status</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Placement</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Posture</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Identity socket</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Host</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Drone build</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Last hello</th>
                <th className="px-3 py-2 font-medium text-muted-foreground text-right">Pending tokens</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Identity liveness</th>
                <th className="px-3 py-2 font-medium text-muted-foreground w-[200px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.instances.map((inst) => {
                const linked = inst.boardAgents.filter((a) => a.connected).length;
                const attached = inst.boardAgents.length;
                const label =
                  inst.hostname ??
                  (inst.stableInstanceId.length > 12
                    ? `${inst.stableInstanceId.slice(0, 8)}…`
                    : inst.stableInstanceId);
                const placementExtra = dronePlacementSummary(inst);
                const socketState: SocketState = inst.connected ? "open" : "closed";
                const latestHeartbeat = latestSignalDate(
                  inst.boardAgents.map((agent) => parseIsoDate(agent.lastHeartbeatAt)),
                );
                const latestDroneSignal = latestSignalDate([
                  parseIsoDate(inst.lastHelloAt),
                  parseIsoDate(inst.lastSeenAt),
                  latestHeartbeat,
                ]);
                const livenessState = classifyDroneLiveness(socketState, latestDroneSignal);
                const lastHelloParsed = parseIsoDate(inst.lastHelloAt);
                const helloTelemetryStale =
                  socketState === "open" &&
                  lastHelloParsed !== null &&
                  Date.now() - lastHelloParsed.getTime() > FLAKY_RECENCY_MS;
                const linkage = linkageBadge(attached, linked);
                return (
                  <Fragment key={inst.id}>
                    <tr className="border-b border-border bg-muted/25">
                      <td colSpan={11} className="px-3 py-2 text-xs font-medium text-foreground">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-muted-foreground">Drone</span> · {label}
                            {inst.version ? (
                              <>
                                {" "}
                                · <span className="font-mono">{inst.version}</span>
                              </>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2 shrink-0">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() =>
                                setAttachIdentityTarget({ workerInstanceId: inst.id, droneLabel: label })
                              }
                            >
                              Attach identity
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() =>
                                setInstanceEnrollTarget({ workerInstanceId: inst.id, droneLabel: label })
                              }
                            >
                              Instance link token
                            </Button>
                            {inst.drainRequestedAt ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                disabled={
                                  patchWorkerInstance.isPending &&
                                  patchWorkerInstance.variables?.workerInstanceId === inst.id
                                }
                                title="Clear drain flag on this drone row"
                                onClick={() =>
                                  patchWorkerInstance.mutate({
                                    workerInstanceId: inst.id,
                                    body: { drainRequested: false },
                                  })
                                }
                              >
                                Clear drain
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                disabled={
                                  patchWorkerInstance.isPending &&
                                  patchWorkerInstance.variables?.workerInstanceId === inst.id
                                }
                                title="Mark draining so new automatic placements skip this drone; with HIVE_DRAIN_AUTO_EVACUATE_ENABLED, automatic identities rebind to another eligible host"
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      "Request drain for this drone? New automatic pool placements will avoid it. If the server has HIVE_DRAIN_AUTO_EVACUATE_ENABLED=true, identities with automatic assignment move to another eligible drone when possible.",
                                    )
                                  ) {
                                    return;
                                  }
                                  patchWorkerInstance.mutate({
                                    workerInstanceId: inst.id,
                                    body: { drainRequested: true },
                                  });
                                }}
                              >
                                Request drain
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className="h-8 text-xs"
                              disabled={deleteWorkerInstance.isPending}
                              title="Remove this drone row from the board (clears bindings; host may re-enroll if still running)"
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    "Remove this drone from the board? Bindings to this host are cleared. If hive-worker is still running, it can show up again after hello.",
                                  )
                                ) {
                                  return;
                                }
                                deleteWorkerInstance.mutate(inst.id);
                              }}
                            >
                              Remove drone
                            </Button>
                          </div>
                        </div>
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          <div className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2 space-y-1.5">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Drone health</p>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={cn("text-[11px] font-medium rounded-full px-2 py-0.5", socketBadgeClass(socketState))}
                                title="Socket transport state for this drone on the current API node"
                              >
                                {socketState === "open" ? "Socket open (this node)" : "Socket closed"}
                              </span>
                              <span
                                className={cn("text-[11px] font-medium rounded-full px-2 py-0.5", livenessBadgeClass(livenessState))}
                                title="Open socket on this node counts as healthy; when the socket is closed, uses last hello / seen / heartbeat age"
                              >
                                {livenessState === "healthy" ? "Liveness: Healthy" : livenessState === "flaky" ? "Liveness: Flaky" : "Liveness: Offline"}
                              </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              Last hello {inst.lastHelloAt ? relativeTime(inst.lastHelloAt) : "—"} · Last seen{" "}
                              {inst.lastSeenAt ? relativeTime(inst.lastSeenAt) : "—"} · Last heartbeat{" "}
                              {latestHeartbeat ? relativeTime(latestHeartbeat.toISOString()) : "—"}
                            </p>
                            {helloTelemetryStale ? (
                              <p className="text-[11px] text-muted-foreground/90">
                                Stored <code className="font-mono text-[10px]">hello</code> timestamp is old; the link is
                                still up. A new <code className="font-mono text-[10px]">hello</code> refreshes host/build
                                metadata.
                              </p>
                            ) : null}
                          </div>
                          <div className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2 space-y-1.5">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Identity linkage</p>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={cn("text-[11px] font-medium rounded-full px-2 py-0.5", linkage.className)}>
                                {linkage.label}
                              </span>
                              <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
                                Attached {attached}
                              </span>
                              <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
                                Linked now {linked}
                              </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              Unassigned identities in company: {data.unassignedBoardAgents.length}
                            </p>
                          </div>
                        </div>
                        {placementExtra ? (
                          <p className="text-xs font-normal text-muted-foreground mt-2 pt-2 border-t border-border/50">
                            {placementExtra}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                    {renderAgentRows(inst.boardAgents)}
                  </Fragment>
                );
              })}
              {data.unassignedBoardAgents.length > 0 ? (
                <>
                  <tr className="border-b border-border bg-muted/25">
                    <td colSpan={11} className="px-3 py-2 text-xs font-medium text-foreground">
                      <span className="text-muted-foreground">Identities not assigned to a drone row yet</span> — use{" "}
                      <strong className="text-foreground font-medium">Attach identity</strong> or{" "}
                      <strong className="text-foreground font-medium">Assign to drone</strong>. Multi-identity on one process still uses{" "}
                      <code className="font-mono text-[11px]">HIVE_WORKER_LINKS_JSON</code> per <code className="font-mono text-[11px]">DRONE-SPEC</code>.
                    </td>
                  </tr>
                  {renderAgentRows(data.unassignedBoardAgents)}
                </>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
