import { AlertTriangle } from "lucide-react";

type Props = {
  /** False when the control plane has no `HIVE_WORKER_DELIVERY_BUS_URL` (multi-replica HA needs it). */
  workerDeliveryBusConfigured: boolean | undefined;
};

/**
 * Shown on the deploy sheet when the API reports that cross-replica worker delivery is not configured.
 * Single-replica installs can ignore; HA operators should set the bus.
 */
export function WorkerDeliveryBusHint({ workerDeliveryBusConfigured }: Props) {
  if (workerDeliveryBusConfigured !== false) {
    return null;
  }
  return (
    <div
      className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      role="status"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p>
        <span className="font-medium">Multiple API replicas: </span>
        This control plane does not have <code className="font-mono text-[11px]">HIVE_WORKER_DELIVERY_BUS_URL</code> set.
        If you run <strong className="text-foreground">more than one</strong> API instance, configure a shared
        Redis-protocol bus so worker WebSocket delivery reaches the right replica (
        <a
          href="https://github.com/Enkom-Tech/Hive/blob/main/control-plane/doc/adr/003-unified-managed-worker-links.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
        >
          ADR 003
        </a>
        ).
      </p>
    </div>
  );
}
