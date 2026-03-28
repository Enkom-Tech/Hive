/// <reference path="./types/express.d.ts" />
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import detectPort from "detect-port";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl } from "./board-claim.js";
import { applyServerEnvConfig } from "./bootstrap/env.js";
import { bootstrapDatabase, type BootstrapDatabaseResult } from "./bootstrap/db.js";
import { bootstrapAuth } from "./bootstrap/auth.js";
import { bootstrapRuntime } from "./bootstrap/runtime.js";
import { setupSchedulers } from "./bootstrap/scheduler.js";
import { hiveEnv, setHiveEnv } from "./bootstrap/hive-env.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  const config = loadConfig();
  await applyServerEnvConfig(config);

  let db: BootstrapDatabaseResult["db"];
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: BootstrapDatabaseResult["migrationSummary"] = "skipped";
  let activeDatabaseConnectionString: string;
  let startupDbInfo: BootstrapDatabaseResult["startupDbInfo"];
  const dbBootstrap = await bootstrapDatabase(config);
  db = dbBootstrap.db;
  embeddedPostgres = dbBootstrap.embeddedPostgres;
  embeddedPostgresStartedByThisProcess = dbBootstrap.embeddedPostgresStartedByThisProcess;
  migrationSummary = dbBootstrap.migrationSummary;
  activeDatabaseConnectionString = dbBootstrap.activeDatabaseConnectionString;
  startupDbInfo = dbBootstrap.startupDbInfo;

  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let principalResolver: (req: ExpressRequest) => Promise<import("@hive/shared").Principal | null>;

  const authBootstrap = await bootstrapAuth(config, db);
  authReady = authBootstrap.authReady;
  betterAuthHandler = authBootstrap.betterAuthHandler;
  resolveSession = authBootstrap.resolveSession;
  resolveSessionFromHeaders = authBootstrap.resolveSessionFromHeaders;
  principalResolver = authBootstrap.principalResolver;

  const listenPort = await detectPort(config.port);
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const app = await createApp(db, {
    uiMode,
    serverPort: listenPort,
    storageService,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    secretsStrictMode: config.secretsStrictMode,
    secretsProvider: config.secretsProvider,
    joinAllowedAdapterTypes: config.joinAllowedAdapterTypes
      ? config.joinAllowedAdapterTypes.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    managedWorkerUrlAllowlist: config.managedWorkerUrlAllowlist
      ? config.managedWorkerUrlAllowlist.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : undefined,
    corsAllowlist: config.corsAllowlist,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    metricsEnabled: config.metricsEnabled,
    drainAutoEvacuateEnabled: config.drainAutoEvacuateEnabled,
    drainCancelInFlightPlacementsEnabled: config.drainCancelInFlightPlacementsEnabled,
    vcsGitHubWebhookEnabled: config.vcsGitHubWebhookEnabled,
    vcsGitHubWebhookSecret: config.vcsGitHubWebhookSecret,
    vcsGitHubAllowedRepos: config.vcsGitHubAllowedRepos,
    workerIdentityAutomationEnabled: config.workerIdentityAutomationEnabled,
    apiPublicBaseUrl: config.authPublicBaseUrl,
    workerProvisionManifestJson: config.workerProvisionManifestJson,
    workerProvisionManifestFile: config.workerProvisionManifestFile,
    workerProvisionManifestSigningKeyPem: config.workerProvisionManifestSigningKeyPem,
    internalHiveOperatorSecret: config.internalHiveOperatorSecret,
    pluginHostSecret: config.pluginHostSecret,
    e2eMcpSmokeMaterializeSecret: config.e2eMcpSmokeMaterializeSecret,
    bifrostAdminBaseUrl: config.bifrostAdminBaseUrl,
    bifrostAdminToken: config.bifrostAdminToken,
    authPublicBaseUrl: config.authPublicBaseUrl,
    authDisableSignUp: config.authDisableSignUp,
    betterAuthHandler,
    resolveSession,
    principalResolver,
    activeDatabaseConnectionString,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }

  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  setHiveEnv("LISTEN_HOST", runtimeListenHost);
  setHiveEnv("LISTEN_PORT", String(listenPort));
  setHiveEnv("API_URL", `http://${runtimeApiHost}:${listenPort}`);

  const { heartbeat } = await bootstrapRuntime(server, db, config, {
    resolveSessionFromHeaders,
  });
  setupSchedulers({ config, db, heartbeat, activeDatabaseConnectionString });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (hiveEnv("OPEN_ON_LISTEN") === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
      printStartupBanner({
        host: config.host,
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
        agentJwtSecretSet: !!config.authSecret,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      logger.info({ signal }, "Stopping embedded PostgreSQL");
      try {
        await embeddedPostgres?.stop();
      } catch (err) {
        logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
      } finally {
        process.exit(0);
      }
    };
  
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: hiveEnv("API_URL") ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Hive server failed to start");
    process.exit(1);
  });
}
