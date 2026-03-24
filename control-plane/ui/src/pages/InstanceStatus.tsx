import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { InstanceStatusMigrationDetail, InstanceStatusSubsystemState } from "@hive/shared";
import { Link } from "@/lib/router";
import { instanceApi } from "../api/instance";
import { ApiError } from "../api/client";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";

function isMigrationDetail(m: unknown): m is InstanceStatusMigrationDetail {
  return typeof m === "object" && m !== null && "appliedMigrations" in m;
}

function subsystemRank(s: InstanceStatusSubsystemState): number {
  switch (s) {
    case "ok":
      return 0;
    case "unknown":
      return 1;
    case "degraded":
      return 2;
    case "critical":
      return 3;
    default:
      return 0;
  }
}

function worstSubsystem(subsystems: Record<string, InstanceStatusSubsystemState>): {
  key: string;
  state: InstanceStatusSubsystemState;
} {
  let worstKey = "api";
  let worst: InstanceStatusSubsystemState = "ok";
  let r = 0;
  for (const [key, state] of Object.entries(subsystems)) {
    const nr = subsystemRank(state);
    if (nr > r) {
      r = nr;
      worst = state;
      worstKey = key;
    }
  }
  return { key: worstKey, state: worst };
}

function SubsystemBadge({ label, state }: { label: string; state: InstanceStatusSubsystemState }) {
  const variant =
    state === "ok"
      ? "outline"
      : state === "degraded"
        ? "secondary"
        : state === "critical"
          ? "destructive"
          : "outline";
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-muted-foreground truncate">{label}</span>
      <Badge variant={variant} className="w-fit capitalize">
        {state}
      </Badge>
    </div>
  );
}

export function InstanceStatus() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Status" }]);
  }, [setBreadcrumbs]);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.status,
    queryFn: () => instanceApi.getStatus(),
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
  });

  const migrateMutation = useMutation({
    mutationFn: () => instanceApi.applyMigrations(),
    onSuccess: async () => {
      setMigrateError(null);
      setMigrateOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.status });
    },
    onError: (err: unknown) => {
      setMigrateError(err instanceof ApiError ? err.message : "Migration apply failed.");
    },
  });

  const data = statusQuery.data;
  const worst = data ? worstSubsystem(data.subsystems) : null;
  const overallLabel = useMemo(() => {
    if (!worst) return "";
    if (worst.state === "ok") return "All reported subsystems are healthy.";
    if (worst.state === "unknown") return "Some checks could not run; review details below.";
    if (worst.state === "degraded") return "Degraded: review migrations, schedulers, or workload.";
    return "Critical: address database or migration state before continuing.";
  }, [worst]);

  if (statusQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading instance status…</div>;
  }

  if (statusQuery.error || !data) {
    return (
      <div className="text-sm text-destructive">
        {statusQuery.error instanceof Error ? statusQuery.error.message : "Failed to load status."}
      </div>
    );
  }

  const migration = data.migration;
  const detail = isMigrationDetail(migration) ? migration : null;
  const lastApplied =
    detail && detail.appliedMigrations.length > 0
      ? detail.appliedMigrations[detail.appliedMigrations.length - 1]
      : null;

  return (
    <div className="max-w-5xl space-y-6">
      <div
        className={cn(
          "rounded-lg border px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
          worst?.state === "critical" && "border-destructive/60 bg-destructive/5",
          worst?.state === "degraded" && "border-amber-500/50 bg-amber-500/5",
          worst?.state === "unknown" && "border-border bg-muted/20",
          worst?.state === "ok" && "border-border bg-muted/10",
        )}
      >
        <div className="space-y-1 min-w-0">
          <h1 className="text-lg font-semibold">Instance status</h1>
          <p className="text-sm text-muted-foreground">{overallLabel}</p>
          <p className="text-xs text-muted-foreground">
            Refreshed {formatDateTime(new Date(data.timestamp * 1000))} · App {data.appVersion}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}
        >
          <RefreshCw className={cn("h-4 w-4 mr-2", statusQuery.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <SubsystemBadge label="API" state={data.subsystems.api} />
        <SubsystemBadge label="Database" state={data.subsystems.database} />
        <SubsystemBadge label="Migrations" state={data.subsystems.migrations} />
        <SubsystemBadge label="Auth / bootstrap" state={data.subsystems.authBootstrap} />
        <SubsystemBadge label="Schedulers" state={data.subsystems.schedulers} />
        <SubsystemBadge label="Workload" state={data.subsystems.workload} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="pt-6 space-y-3">
            <h2 className="text-sm font-semibold">Version &amp; updates</h2>
            <p className="text-sm text-muted-foreground">
              Current <span className="font-mono text-foreground">{data.releases.currentVersion}</span>
              {data.releases.latestVersion && (
                <>
                  {" "}
                  · Latest <span className="font-mono text-foreground">{data.releases.latestVersion}</span>
                </>
              )}
            </p>
            {data.releases.releasesUrl && (
              <a
                href={data.releases.releasesUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                View releases
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-3">
            <h2 className="text-sm font-semibold">Prometheus</h2>
            <p className="text-sm text-muted-foreground">
              {data.prometheus.enabled
                ? `Scrape ${data.prometheus.scrapePath ?? "/api/metrics"} from your monitor.`
                : "Metrics export is disabled for this deployment."}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Database migrations</h2>
            <Badge variant={migration.pending ? "secondary" : "default"}>
              {migration.status === "upToDate"
                ? "Up to date"
                : migration.status === "needsMigrations"
                  ? "Pending"
                  : "Unavailable"}
            </Badge>
          </div>
          {migration.status === "unavailable" && (
            <p className="text-sm text-muted-foreground">
              Migration state could not be read (database unreachable or connection not configured on the server).
            </p>
          )}
          {migration.pending && (
            <p className="text-sm text-muted-foreground">
              {migration.pendingCount} pending migration{migration.pendingCount === 1 ? "" : "s"}.
              {migration.reason === "no-migration-journal-non-empty-db" &&
                " The schema may pre-date Hive migrations; use the operator runbook."}
            </p>
          )}
          {lastApplied && (
            <p className="text-xs text-muted-foreground font-mono break-all">Latest applied: {lastApplied}</p>
          )}
          {detail && detail.pendingMigrations.length > 0 && (
            <ul className="text-xs font-mono text-muted-foreground list-disc pl-4 space-y-1 max-h-40 overflow-y-auto">
              {detail.pendingMigrations.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="default"
              disabled={!data.migrationsApplyAllowed || migrateMutation.isPending}
              onClick={() => {
                setMigrateError(null);
                setMigrateOpen(true);
              }}
            >
              Run migrations
            </Button>
            {!data.migrationsApplyAllowed && (
              <span className="text-xs text-muted-foreground self-center">
                {!detail
                  ? "Instance admins see migration file names, workload hotspots, and may enable UI apply."
                  : migration.status !== "needsMigrations" || migration.reason !== "pending-migrations"
                    ? "Only standard pending migrations can be applied from the UI."
                    : "Enable HIVE_UI_MIGRATIONS_ENABLED=1 (off by default except local_trusted)."}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <h2 className="text-sm font-semibold">Scheduler heartbeats</h2>
          <p className="text-sm text-muted-foreground">
            {data.schedulers.totalSchedulers} timer heartbeat agents · {data.schedulers.activeCount} active ·{" "}
            {data.schedulers.staleCount} stale
            {data.schedulers.maxStalenessSeconds != null && (
              <> · max staleness {data.schedulers.maxStalenessSeconds}s</>
            )}
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/instance/settings">Open heartbeat settings</Link>
          </Button>
        </CardContent>
      </Card>

      {data.workloadTop && data.workloadTop.length > 0 && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <h2 className="text-sm font-semibold">Workload hotspots (top companies)</h2>
            <ul className="space-y-3">
              {data.workloadTop.map((row) => (
                <li key={row.companyId} className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{row.companyName}</span>
                    <Badge variant={row.action === "normal" ? "outline" : "secondary"} className="capitalize">
                      {row.action}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{row.reason}</p>
                  {row.details.length > 0 && (
                    <ul className="text-xs text-muted-foreground list-disc pl-4 mt-1">
                      {row.details.slice(0, 3).map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6 space-y-2">
          <h2 className="text-sm font-semibold">Deployment</h2>
          <p className="text-sm text-muted-foreground">
            Mode <span className="text-foreground">{data.deployment.deploymentMode}</span> · exposure{" "}
            <span className="text-foreground">{data.deployment.deploymentExposure}</span>
            {data.deployment.deploymentMode === "authenticated" && (
              <>
                {" "}
                · bootstrap{" "}
                <span className="text-foreground">{data.deployment.bootstrapStatus}</span>
              </>
            )}
          </p>
        </CardContent>
      </Card>

      <Dialog open={migrateOpen} onOpenChange={setMigrateOpen}>
        <DialogContent showCloseButton={!migrateMutation.isPending}>
          <DialogHeader>
            <DialogTitle>Apply pending migrations?</DialogTitle>
            <DialogDescription>
              This runs the same migration job as the CLI on the server database. Brief locks may occur. Production
              deployments should normally use release automation or{" "}
              <code className="text-xs bg-muted px-1 rounded">pnpm db:migrate</code>.
            </DialogDescription>
          </DialogHeader>
          {migrateError && <p className="text-sm text-destructive">{migrateError}</p>}
          {detail && detail.pendingMigrations.length > 0 && (
            <ul className="text-xs font-mono max-h-32 overflow-y-auto list-disc pl-4 text-muted-foreground">
              {detail.pendingMigrations.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={migrateMutation.isPending} onClick={() => setMigrateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={migrateMutation.isPending}
              onClick={() => {
                setMigrateError(null);
                migrateMutation.mutate();
              }}
            >
              {migrateMutation.isPending ? "Applying…" : "Apply migrations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
