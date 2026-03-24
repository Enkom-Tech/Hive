import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import detectPort from "detect-port";
import type { Db } from "@hive/db";
import {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
} from "@hive/db";
import { logger } from "../middleware/logger.js";
import { hiveEnv } from "./hive-env.js";
import type { Config } from "../config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type StartupDbInfo =
  | { mode: "external-postgres"; connectionString: string }
  | { mode: "embedded-postgres"; dataDir: string; port: number };

type MigrationSummary =
  | "skipped"
  | "already applied"
  | "applied (empty database)"
  | "applied (pending migrations)"
  | "pending migrations skipped";

export interface BootstrapDatabaseResult {
  db: Db;
  embeddedPostgres: EmbeddedPostgresInstance | null;
  embeddedPostgresStartedByThisProcess: boolean;
  activeDatabaseConnectionString: string;
  startupDbInfo: StartupDbInfo;
  migrationSummary: MigrationSummary;
}

export async function bootstrapDatabase(config: Config): Promise<BootstrapDatabaseResult> {
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;

  let migrationSummary: MigrationSummary = "skipped";
  let db: Db;
  let activeDatabaseConnectionString: string;
  let startupDbInfo: StartupDbInfo;

  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }

  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (hiveEnv("MIGRATION_PROMPT") === "never") return false;
    if (hiveEnv("MIGRATION_AUTO_APPLY") === "true") return true;
    if (!stdin.isTTY || !stdout.isTTY) return true;

    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }

  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };

  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        logger.warn(
          { pendingMigrations: state.pendingMigrations },
          `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
        );
        return "pending migrations skipped";
      }

      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }

    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      logger.warn(
        { pendingMigrations: state.pendingMigrations },
        `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
      );
      return "pending migrations skipped";
    }

    logger.info(
      { pendingMigrations: state.pendingMigrations },
      `Applying ${state.pendingMigrations.length} pending migrations for ${label}`,
    );
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }

  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }

    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const embeddedPostgresLogBuffer: string[] = [];
    const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
    const verboseEmbeddedPostgresLogs = hiveEnv("EMBEDDED_POSTGRES_VERBOSE") === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
      for (const lineRaw of text.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line) continue;
        embeddedPostgresLogBuffer.push(line);
        if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
          embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
        }
        if (verboseEmbeddedPostgresLogs) {
          logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
        }
      }
    };

    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      if (embeddedPostgresLogBuffer.length > 0) {
        logger.error(
          {
            phase,
            recentLogs: embeddedPostgresLogBuffer,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };

    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }

    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };

    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const detectedPort = await detectPort(configuredPort);
      if (detectedPort !== configuredPort) {
        logger.warn(
          `Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`,
        );
      }
      port = detectedPort;
      logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
      embeddedPostgres = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "hive",
        password: "hive",
        port,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
        onLog: appendEmbeddedPostgresLog,
        onError: appendEmbeddedPostgresLog,
      });

      if (!clusterAlreadyInitialized) {
        try {
          await embeddedPostgres.initialise();
        } catch (err) {
          logEmbeddedPostgresFailure("initialise", err);
          throw err;
        }
      } else {
        logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
      }

      if (existsSync(postmasterPidFile)) {
        logger.warn("Removing stale embedded PostgreSQL lock file");
        rmSync(postmasterPidFile, { force: true });
      }

      try {
        await embeddedPostgres.start();
      } catch (err) {
        logEmbeddedPostgresFailure("start", err);
        throw err;
      }
      embeddedPostgresStartedByThisProcess = true;
    }

    const embeddedAdminConnectionString = `postgres://hive:hive@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "hive");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: hive");
    }

    const embeddedConnectionString = `postgres://hive:hive@127.0.0.1:${port}/hive`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }

    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });

    db = createDb(embeddedConnectionString);
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }

  return {
    db,
    embeddedPostgres,
    embeddedPostgresStartedByThisProcess,
    activeDatabaseConnectionString,
    startupDbInfo,
    migrationSummary,
  };
}

