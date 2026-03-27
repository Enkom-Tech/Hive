import { Counter, Histogram, Registry } from "prom-client";
import { logger } from "./middleware/logger.js";

let metricsRegistry: Registry | null = null;
let placementEventsCounter: Counter<"event"> | null = null;
let workerApiRequestsCounter: Counter<"method" | "route" | "status_class"> | null = null;
let workerApiDurationHistogram: Histogram<"method" | "route"> | null = null;

/** Test-only: clear registry so worker-api metrics tests can re-init. */
export function resetPrometheusRegistryForTests(): void {
  metricsRegistry = null;
  placementEventsCounter = null;
  workerApiRequestsCounter = null;
  workerApiDurationHistogram = null;
}

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
  workerApiRequestsCounter = new Counter({
    name: "hive_worker_api_requests_total",
    help: "HTTP requests to /api/worker-api/* (low-cardinality route labels only)",
    labelNames: ["method", "route", "status_class"],
    registers: [reg],
  });
  workerApiDurationHistogram = new Histogram({
    name: "hive_worker_api_request_duration_seconds",
    help: "Latency for /api/worker-api/* handlers",
    labelNames: ["method", "route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
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

/** Map path (relative to /worker-api mount) + method to a fixed route label — no UUIDs in labels. */
export function inferWorkerApiRouteLabel(path: string, method: string): string {
  const p = path.split("?")[0] ?? path;
  const m = method.toUpperCase();
  if (p === "/cost-report") return "cost_report";
  if (p === "/issues" && m === "POST") return "issue_create";
  if (p === "/agent-hires" && m === "POST") return "agent_hire";
  if (/^\/issues\/[^/]+\/comments$/.test(p)) return "issue_comment";
  if (/^\/issues\/[^/]+\/transition$/.test(p)) return "issue_transition";
  if (m === "GET" && /^\/issues\/[^/]+$/.test(p)) return "issue_get";
  if (m === "PATCH" && /^\/issues\/[^/]+$/.test(p)) return "issue_update";
  return "other";
}

function statusCodeToClass(code: number): string {
  if (code === 401) return "401";
  if (code === 403) return "403";
  if (code === 429) return "429";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500) return "5xx";
  return "other";
}

export function observeWorkerApiRequest(args: {
  method: string;
  path: string;
  statusCode: number;
  durationSeconds: number;
}): void {
  if (!workerApiRequestsCounter || !workerApiDurationHistogram) return;
  const route = inferWorkerApiRouteLabel(args.path, args.method);
  const m = args.method.toUpperCase();
  const status_class = statusCodeToClass(args.statusCode);
  workerApiRequestsCounter.inc({ method: m, route, status_class });
  workerApiDurationHistogram.observe({ method: m, route }, args.durationSeconds);
}
