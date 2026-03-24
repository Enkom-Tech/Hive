import { Counter, Registry } from "prom-client";
import { logger } from "./middleware/logger.js";

let metricsRegistry: Registry | null = null;
let placementEventsCounter: Counter<"event"> | null = null;

/** Call once at process start when HIVE_METRICS_ENABLED is true. */
export function initPlacementPrometheus(enabled: boolean): void {
  if (!enabled || metricsRegistry) return;
  const reg = new Registry();
  placementEventsCounter = new Counter({
    name: "hive_placement_events_total",
    help: "Managed-worker placement lifecycle (ADR 002/003)",
    labelNames: ["event"],
    registers: [reg],
  });
  metricsRegistry = reg;
}

export async function renderPlacementPrometheusScrape(): Promise<{ body: string; contentType: string } | null> {
  if (!metricsRegistry) return null;
  const body = await metricsRegistry.metrics();
  return { body, contentType: "text/plain; version=0.0.4; charset=utf-8" };
}

/** Structured placement events for operators / log aggregators; optional Prometheus counter. */
export function logPlacementMetric(
  event:
    | "placement_created"
    | "placement_dispatch_failed"
    | "placement_dispatch_retry_scheduled"
    | "placement_active"
    | "placement_rejected"
    | "placement_mobility",
  fields: Record<string, unknown>,
): void {
  logger.info({ placementMetric: event, ...fields }, "placement");
  placementEventsCounter?.inc({ event }, 1);
}
