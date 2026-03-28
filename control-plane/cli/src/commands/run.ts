import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { loadHiveEnvFile } from "../config/env.js";
import { configExists, resolveConfigPath } from "../config/store.js";
import type { HiveConfig } from "../config/schema.js";
import { readConfig } from "../config/store.js";
import {
  describeLocalInstancePaths,
  resolveHiveHomeDir,
  resolveHiveInstanceId,
} from "../config/home.js";
import {
  resolvePublishedServerMain,
  startServerSubprocess,
  waitForSubprocessExit,
} from "../lib/start-server-subprocess.js";

interface RunOptions {
  config?: string;
  instance?: string;
  repair?: boolean;
  yes?: boolean;
}

interface StartedServer {
  apiUrl: string;
  databaseUrl: string;
  host: string;
  listenPort: number;
}

function resolveCliPostgresUrl(config: HiveConfig): string | undefined {
  if (config.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return config.database.connectionString.trim();
  }
  return process.env.DATABASE_URL?.trim();
}

function resolveCliServerSubprocessMode(
  config: HiveConfig,
  publishedMain: string | null,
): { useSubprocess: boolean; reason: "env" | "auto" | null } {
  const raw = process.env.HIVE_CLI_SERVER_SUBPROCESS?.trim().toLowerCase();
  if (raw === "0" || raw === "false") {
    return { useSubprocess: false, reason: null };
  }
  if (raw === "1" || raw === "true") {
    return { useSubprocess: true, reason: "env" };
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    return { useSubprocess: false, reason: null };
  }
  if (!publishedMain) {
    return { useSubprocess: false, reason: null };
  }
  const dbUrl = resolveCliPostgresUrl(config);
  if (!dbUrl) {
    return { useSubprocess: false, reason: null };
  }
  return { useSubprocess: true, reason: "auto" };
}

export async function runCommand(opts: RunOptions): Promise<void> {
  const instanceId = resolveHiveInstanceId(opts.instance);
  process.env.HIVE_INSTANCE_ID = instanceId;

  const homeDir = resolveHiveHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const paths = describeLocalInstancePaths(instanceId);
  fs.mkdirSync(paths.instanceRoot, { recursive: true });

  const configPath = resolveConfigPath(opts.config);
  process.env.HIVE_CONFIG = configPath;
  loadHiveEnvFile(configPath);

  p.intro(pc.bgCyan(pc.black(" hive run ")));
  p.log.message(pc.dim(`Home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Config: ${configPath}`));

  if (!configExists(configPath)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      p.log.error("No config found and terminal is non-interactive.");
      p.log.message(`Run ${pc.cyan("hive onboard")} once, then retry ${pc.cyan("hive run")}.`);
      process.exit(1);
    }

    p.log.step("No config found. Starting onboarding...");
    await onboard({ config: configPath, invokedByRun: true });
  }

  p.log.step("Running doctor checks...");
  const summary = await doctor({
    config: configPath,
    repair: opts.repair ?? true,
    yes: opts.yes ?? true,
  });

  if (summary.failed > 0) {
    p.log.error("Doctor found blocking issues. Not starting server.");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}.`);
    process.exit(1);
  }

  p.log.step("Starting Hive server...");

  const publishedMain = resolvePublishedServerMain();
  const subprocessDecision = resolveCliServerSubprocessMode(config, publishedMain);

  if (subprocessDecision.useSubprocess) {
    if (!publishedMain) {
      throw new Error(
        "Subprocess mode requires a built @hive/server (dist/index.js). Build the server package or set HIVE_CLI_SERVER_SUBPROCESS=0 to use the in-process server.",
      );
    }
    if (subprocessDecision.reason === "auto") {
      p.log.message(
        pc.dim(
          "Starting packaged server in a subprocess (Postgres + dist/index.js detected). HIVE_CLI_SERVER_SUBPROCESS=0 forces in-process.",
        ),
      );
    }
    const { started, child } = await startServerSubprocess(publishedMain, config);
    const startedServer: StartedServer = {
      apiUrl: started.apiUrl,
      databaseUrl: started.databaseUrl,
      host: started.host,
      listenPort: started.listenPort,
    };
    if (shouldGenerateBootstrapInviteAfterStart(config)) {
      p.log.step("Generating bootstrap CEO invite");
      await bootstrapCeoInvite({
        config: configPath,
        dbUrl: startedServer.databaseUrl,
        baseUrl: resolveBootstrapInviteBaseUrl(config, startedServer),
      });
    }
    p.outro(pc.green("Hive server is running in a subprocess. Press Ctrl+C to stop."));
    await waitForSubprocessExit(child);
    return;
  }

  const startedServer = await importServerEntry();

  if (shouldGenerateBootstrapInviteAfterStart(config)) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: startedServer.databaseUrl,
      baseUrl: resolveBootstrapInviteBaseUrl(config, startedServer),
    });
  }
}

function resolveBootstrapInviteBaseUrl(
  config: HiveConfig,
  startedServer: StartedServer,
): string {
  const explicitBaseUrl =
    process.env.HIVE_PUBLIC_URL ??
    process.env.HIVE_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    (config.auth.baseUrlMode === "explicit" ? config.auth.publicBaseUrl : undefined);

  if (typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0) {
    return explicitBaseUrl.trim().replace(/\/+$/, "");
  }

  return startedServer.apiUrl.replace(/\/api$/, "");
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") return true;
  return err.message.includes("Cannot find module");
}

function getMissingModuleSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const packageMatch = err.message.match(/Cannot find package '([^']+)' imported from/);
  if (packageMatch?.[1]) return packageMatch[1];
  const moduleMatch = err.message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch?.[1]) return moduleMatch[1];
  return null;
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.HIVE_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@hive/server/src/index.ts")) {
    process.env.HIVE_UI_DEV_MIDDLEWARE = "true";
  }
}

async function importServerEntry(): Promise<StartedServer> {
  // Dev mode: try local workspace path (monorepo with tsx)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    maybeEnableUiDevMiddleware(devEntry);
    const mod = await import(pathToFileURL(devEntry).href);
    return await startServerFromModule(mod, devEntry);
  }

  // Production mode: import the published @hive/server package
  try {
    const mod = await import("@hive/server");
    return await startServerFromModule(mod, "@hive/server");
  } catch (err) {
    const missingSpecifier = getMissingModuleSpecifier(err);
    const missingServerEntrypoint = !missingSpecifier || missingSpecifier === "@hive/server";
    if (isModuleNotFoundError(err) && missingServerEntrypoint) {
      throw new Error(
        `Could not locate a Hive server entrypoint.\n` +
          `Tried: ${devEntry}, @hive/server\n` +
          `${formatError(err)}`,
      );
    }
    throw new Error(
      `Hive server failed to start.\n` +
        `${formatError(err)}`,
    );
  }
}

function shouldGenerateBootstrapInviteAfterStart(config: HiveConfig): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode === "embedded-postgres";
}

async function startServerFromModule(mod: unknown, label: string): Promise<StartedServer> {
  const startServer = (mod as { startServer?: () => Promise<StartedServer> }).startServer;
  if (typeof startServer !== "function") {
    throw new Error(`Hive server entrypoint did not export startServer(): ${label}`);
  }
  return await startServer();
}
