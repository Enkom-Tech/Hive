import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import pc from "picocolors";
import { resolveCommandContext } from "./client/common.js";

export const DATA_DIR_OPTION_HELP = "Hive data directory root (isolates state from ~/.hive)";

export function normalizeControlPlaneHttpUrl(apiBase: string): string {
  let b = apiBase.trim().replace(/\/+$/, "");
  if (b.endsWith("/api")) {
    b = b.slice(0, -4).replace(/\/+$/, "");
  }
  return b;
}

function findExecutableOnPath(name: string): string | null {
  const isWin = process.platform === "win32";
  try {
    const cmd = isWin ? `where.exe ${name}` : `command -v ${name}`;
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first && existsSync(first)) return first;
    if (first && !path.isAbsolute(first) && !first.includes(path.sep)) {
      return first;
    }
  } catch {
    // not found
  }
  return null;
}

function findInfraWorkerRoot(): string | null {
  const tryDir = (start: string): string | null => {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      const mod = path.join(dir, "infra", "worker", "go.mod");
      if (existsSync(mod)) return path.join(dir, "infra", "worker");
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };

  const fromCwd = tryDir(process.cwd());
  if (fromCwd) return fromCwd;

  const here = path.dirname(fileURLToPath(import.meta.url));
  return tryDir(here);
}

interface WorkerSpawn {
  cmd: string;
  args: string[];
  cwd?: string;
}

export function resolveWorkerSpawn(opts: { workerBin?: string }): WorkerSpawn | { error: string } {
  const explicit = opts.workerBin?.trim() || process.env.HIVE_WORKER_BIN?.trim();
  if (explicit) {
    const looksLikePath =
      path.isAbsolute(explicit) ||
      explicit.includes("/") ||
      explicit.includes("\\") ||
      (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(explicit));
    if (looksLikePath && !existsSync(explicit)) {
      return { error: `HIVE_WORKER_BIN / --worker-bin path not found: ${explicit}` };
    }
    return { cmd: explicit, args: [] };
  }

  const onPath = findExecutableOnPath("hive-worker");
  if (onPath) return { cmd: onPath, args: [] };

  const root = findInfraWorkerRoot();
  if (root) return { cmd: "go", args: ["run", "./cmd/worker"], cwd: root };

  return {
    error:
      "Could not find a worker to run. Install a hive-worker binary on PATH, set HIVE_WORKER_BIN, or use a checkout that includes infra/worker (pnpm will use go run ./cmd/worker).",
  };
}

export interface WorkerLinkCliOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  agentId: string;
  enrollmentToken?: string;
  agentKey?: string;
  workerBin?: string;
  json?: boolean;
}

export function workerLinkRun(opts: WorkerLinkCliOptions): void {
  const ctx = resolveCommandContext({
    config: opts.config,
    dataDir: opts.dataDir,
    context: opts.context,
    profile: opts.profile,
    apiBase: opts.apiBase,
    json: opts.json,
  });

  const controlPlaneUrl = normalizeControlPlaneHttpUrl(ctx.api.apiBase);
  const enrollment =
    opts.enrollmentToken?.trim() || process.env.HIVE_WORKER_ENROLLMENT_TOKEN?.trim();
  const agentKey =
    opts.agentKey?.trim() ||
    process.env.HIVE_AGENT_KEY?.trim() ||
    process.env.HIVE_CONTROL_PLANE_TOKEN?.trim();
  const linkCredential = enrollment || agentKey;

  if (!linkCredential) {
    console.error(
      pc.red(
        "Missing WebSocket credentials. Prefer HIVE_WORKER_ENROLLMENT_TOKEN or --enrollment-token (short-lived, from the board UI). Otherwise set HIVE_AGENT_KEY / --agent-key (long-lived API key).",
      ),
    );
    process.exit(1);
  }

  const spawnOpts = resolveWorkerSpawn({ workerBin: opts.workerBin });
  if ("error" in spawnOpts) {
    console.error(pc.red(spawnOpts.error));
    process.exit(1);
  }

  const env = {
    ...process.env,
    HIVE_CONTROL_PLANE_URL: controlPlaneUrl,
    HIVE_AGENT_KEY: linkCredential,
    HIVE_AGENT_ID: opts.agentId,
  };

  if (!opts.json) {
    console.log(pc.dim(`Using control plane: ${controlPlaneUrl}`));
    console.log(pc.dim(`Agent ID: ${opts.agentId}`));
    console.log(
      pc.dim(enrollment ? "Auth: short-lived enrollment token → HIVE_AGENT_KEY" : "Auth: API key → HIVE_AGENT_KEY"),
    );
    console.log(pc.green("Starting worker (Ctrl+C to stop)…"));
  }

  const child = spawn(spawnOpts.cmd, spawnOpts.args, {
    env,
    stdio: "inherit",
    cwd: spawnOpts.cwd,
    shell: false,
  });

  child.on("error", (err) => {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

export function registerWorkerCommands(program: Command): void {
  const worker = program
    .command("worker")
    .description("Managed worker (drone): connect to the control plane WebSocket link");

  worker
    .command("link")
    .description(
      "Run the worker process. Sets HIVE_CONTROL_PLANE_URL and passes credentials to the worker as HIVE_AGENT_KEY (enrollment token or API key).",
    )
    .requiredOption("-a, --agent-id <id>", "Agent ID this worker serves")
    .option("-c, --config <path>", "Path to Hive config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "HTTP base URL of the control plane (stored as HIVE_CONTROL_PLANE_URL)")
    .option(
      "--enrollment-token <token>",
      "Short-lived enrollment secret (else HIVE_WORKER_ENROLLMENT_TOKEN); preferred over a long-lived API key",
    )
    .option(
      "--agent-key <token>",
      "Plain agent API key for WebSocket auth (else HIVE_AGENT_KEY or HIVE_CONTROL_PLANE_TOKEN)",
    )
    .option("--worker-bin <path>", "hive-worker binary (else HIVE_WORKER_BIN, PATH, or go run in infra/worker)")
    .option("--json", "Minimal log line output only (no status hints before spawn)")
    .action((cmdOpts: WorkerLinkCliOptions) => {
      workerLinkRun(cmdOpts);
    });
}
