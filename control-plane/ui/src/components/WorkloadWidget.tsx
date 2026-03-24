import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { workloadApi } from "../api";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

interface WorkloadWidgetProps {
  companyId: string;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatDelay(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

export function WorkloadWidget({ companyId }: WorkloadWidgetProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.workload(companyId),
    queryFn: () => workloadApi.get(companyId),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2">
        <p className="text-sm text-muted-foreground">Loading workload…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border px-4 py-2">
        <p className="text-sm text-muted-foreground">Workload unavailable</p>
      </div>
    );
  }

  if (!data?.recommendation) return null;

  const { action, reason, details, suggested_delay_ms } = data.recommendation;
  const isNormal = action === "normal";
  const isThrottle = action === "throttle";
  const isShedOrPause = action === "shed" || action === "pause";

  // Use specific detail when it explains the cause (e.g. "No agents online" / "No agents registered")
  const message =
    details?.length > 0 && (action === "pause" || action === "shed" || action === "throttle")
      ? action === "pause"
        ? `${details[0]}. Hold all submissions until agents are back.`
        : details[0]
      : reason;

  const delayLabel =
    suggested_delay_ms > 0
      ? action === "pause"
        ? `Wait at least ${formatDelay(suggested_delay_ms)} before retrying`
        : `Suggested delay: ${formatDelay(suggested_delay_ms)}`
      : null;

  const containerClass = cn(
    "flex flex-wrap items-center gap-2 rounded-lg border px-4 py-2 text-sm",
    isNormal && "border-border bg-muted/30 text-muted-foreground",
    isThrottle && "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-950/60 dark:text-amber-100",
    isShedOrPause && "border-destructive/50 bg-destructive/10 text-destructive dark:border-destructive/40 dark:bg-destructive/20",
  );

  return (
    <div className={containerClass}>
      <Gauge className="h-4 w-4 shrink-0 opacity-70" />
      <span className="font-medium">{titleCase(action)}</span>
      <span className="opacity-90">—</span>
      <span>{message}</span>
      {delayLabel && (
        <>
          <span className="opacity-70">·</span>
          <span>{delayLabel}</span>
        </>
      )}
    </div>
  );
}
