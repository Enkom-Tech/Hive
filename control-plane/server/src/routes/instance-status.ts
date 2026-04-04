import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { applyPendingMigrations, inspectMigrations, type MigrationState } from "@hive/db";
import type {
  InstanceStatusMigrationDetail,
  InstanceStatusMigrationSummary,
  InstanceStatusResponse,
  InstanceStatusSubsystemState,
  InstanceStatusWorkloadRow,
} from "@hive/shared";
import { APP_VERSION } from "@hive/shared/version";
import { conflict, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { collectHealthPayload, type HealthRouteOptions } from "./health.js";
import { assertBoard, assertInstanceAdmin } from "./authz.js";
import { getReleaseCheck } from "../services/release-check.js";
import { loadInstanceSchedulerAgents, summarizeSchedulerAgents } from "../services/instance-scheduler-summary.js";
import { workloadService } from "../services/workload.js";

let migrationApplyInFlight = false;

function parseUiMigrationsEnabled(deploymentMode: HealthRouteOptions["deploymentMode"]): boolean {
  const raw = process.env.HIVE_UI_MIGRATIONS_ENABLED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return deploymentMode === "local_trusted";
}

function isInstanceOperator(principal: { type: string; roles?: string[] } | null | undefined): boolean {
  if (!principal) return false;
  if (principal.type === "system") return true;
  return principal.type === "user" && Boolean(principal.roles?.includes("instance_admin"));
}

function migrationSubsystemState(
  state: MigrationState | null,
  inspectFailed: boolean,
): InstanceStatusSubsystemState {
  if (inspectFailed || !state) return "unknown";
  if (state.status === "upToDate") return "ok";
  if (state.reason === "pending-migrations") return "degraded";
  if (state.reason === "no-migration-journal-non-empty-db") return "critical";
  return "degraded";
}

function toMigrationPayload(
  state: MigrationState | null,
  inspectFailed: boolean,
  fullDetail: boolean,
): InstanceStatusMigrationSummary | InstanceStatusMigrationDetail {
  if (inspectFailed || !state) {
    return { status: "unavailable", pending: false, pendingCount: 0 };
  }
  if (state.status === "upToDate") {
    const base: InstanceStatusMigrationSummary = {
      status: "upToDate",
      pending: false,
      pendingCount: 0,
    };
    if (!fullDetail) return base;
    return {
      ...base,
      tableCount: state.tableCount,
      availableMigrations: state.availableMigrations,
      appliedMigrations: state.appliedMigrations,
      pendingMigrations: [],
    };
  }

  const pendingCount = state.pendingMigrations.length;
  const summary: InstanceStatusMigrationSummary = {
    status: "needsMigrations",
    pending: true,
    pendingCount,
    reason: state.reason,
  };
  if (!fullDetail) return summary;
  return {
    ...summary,
    tableCount: state.tableCount,
    availableMigrations: state.availableMigrations,
    appliedMigrations: state.appliedMigrations,
    pendingMigrations: state.pendingMigrations,
  };
}

function workloadSubsystemState(rows: InstanceStatusWorkloadRow[] | undefined): InstanceStatusSubsystemState {
  if (!rows || rows.length === 0) return "ok";
  const worst = rows[0]?.action;
  if (worst === "pause") return "critical";
  if (worst === "shed") return "critical";
  if (worst === "throttle") return "degraded";
  return "ok";
}

export async function instanceStatusPlugin(
  fastify: FastifyInstance,
  opts: HealthRouteOptions & {
    db: Db;
    activeDatabaseConnectionString?: string;
    metricsEnabled: boolean;
    workload: ReturnType<typeof workloadService>;
  },
): Promise<void> {
  const { db } = opts;

  fastify.get("/api/instance/status", async (req, reply) => {
    assertBoard(req);
    const principal = req.principal ?? null;
    const operator = isInstanceOperator(principal);

    const deployment = await collectHealthPayload(db, opts);
    const nowMs = Date.now();

    let migrationState: MigrationState | null = null;
    let migrationInspectFailed = false;
    if (opts.activeDatabaseConnectionString) {
      try {
        migrationState = await inspectMigrations(opts.activeDatabaseConnectionString);
      } catch (err) {
        migrationInspectFailed = true;
        logger.warn({ err }, "instance status: inspectMigrations failed");
      }
    } else {
      migrationInspectFailed = true;
    }

    const migrationPayload = toMigrationPayload(migrationState, migrationInspectFailed, operator);
    const schedulerItems = await loadInstanceSchedulerAgents(db, principal);
    const schedulers = summarizeSchedulerAgents(schedulerItems, nowMs);

    let workloadTop: InstanceStatusWorkloadRow[] | undefined;
    if (operator) workloadTop = await opts.workload.listTopCompaniesByWorkload(50, 10);

    let releases;
    try { releases = await getReleaseCheck(APP_VERSION); }
    catch { releases = { currentVersion: APP_VERSION }; }

    const authBootstrap: InstanceStatusSubsystemState =
      opts.deploymentMode === "authenticated" && deployment.bootstrapStatus === "bootstrap_pending" ? "degraded" : "ok";
    const schedulersState: InstanceStatusSubsystemState = schedulers.activeCount === 0 ? "ok" : schedulers.staleCount > 0 ? "degraded" : "ok";

    const subsystems = {
      api: "ok" as const,
      database: migrationInspectFailed ? "critical" as const : "ok" as const,
      migrations: migrationSubsystemState(migrationState, migrationInspectFailed),
      authBootstrap,
      schedulers: schedulersState,
      workload: operator ? workloadSubsystemState(workloadTop) : "ok" as const,
    };

    const migrationsApplyAllowed =
      operator &&
      parseUiMigrationsEnabled(opts.deploymentMode) &&
      migrationState?.status === "needsMigrations" &&
      migrationState.reason === "pending-migrations";

    const payload: InstanceStatusResponse = {
      timestamp: Math.floor(nowMs / 1000),
      appVersion: APP_VERSION,
      releases,
      subsystems,
      deployment,
      migration: migrationPayload,
      schedulers,
      prometheus: { enabled: opts.metricsEnabled, scrapePath: opts.metricsEnabled ? "/api/metrics" : null },
      migrationsApplyAllowed,
      workloadTop,
    };

    return reply.send(payload);
  });

  fastify.post("/api/instance/migrations/apply", async (_req, reply) => {
    assertInstanceAdmin(_req);
    if (!parseUiMigrationsEnabled(opts.deploymentMode)) throw forbidden("UI migrations are disabled (set HIVE_UI_MIGRATIONS_ENABLED=1 to enable)");
    if (!opts.activeDatabaseConnectionString) throw forbidden("Database connection not available for migrations");
    if (migrationApplyInFlight) throw conflict("A migration apply is already in progress");

    let state = await inspectMigrations(opts.activeDatabaseConnectionString);
    if (state.status === "upToDate") {
      return reply.send({ ok: true, migration: toMigrationPayload(state, false, true) as InstanceStatusMigrationDetail });
    }
    if (state.reason !== "pending-migrations") {
      throw forbidden(`Cannot apply migrations automatically (${state.reason}). Use the CLI or operator runbook.`);
    }

    migrationApplyInFlight = true;
    try {
      logger.info({ pendingMigrations: state.pendingMigrations }, "instance admin: applying pending migrations via API");
      await applyPendingMigrations(opts.activeDatabaseConnectionString);
      state = await inspectMigrations(opts.activeDatabaseConnectionString);
      logger.info({ status: state.status }, "instance admin: migrations apply finished");
      return reply.send({ ok: true, migration: toMigrationPayload(state, false, true) as InstanceStatusMigrationDetail });
    } catch (err) {
      logger.error({ err }, "instance admin: migrations apply failed");
      throw err;
    } finally {
      migrationApplyInFlight = false;
    }
  });
}
