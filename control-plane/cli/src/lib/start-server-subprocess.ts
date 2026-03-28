import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import type { HiveConfig } from "../config/schema.js";

export interface StartedServerInfo {
  apiUrl: string;
  databaseUrl: string;
  host: string;
  listenPort: number;
}

/** Resolves built `@hive/server` entry when `dist/index.js` exists (published / post-build install). */
export function resolvePublishedServerMain(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve("@hive/server/package.json"));
    const distMain = path.join(dir, "dist", "index.js");
    return fs.existsSync(distMain) ? distMain : null;
  } catch {
    return null;
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms (${url})`);
}

/**
 * Spawns the control-plane API in a separate Node process (no in-process `import("@hive/server")`).
 * Requires external Postgres: set `database.connectionString` or `DATABASE_URL`. Embedded PG + subprocess is unsupported.
 */
export async function startServerSubprocess(
  serverMainJs: string,
  config: HiveConfig,
): Promise<{ started: StartedServerInfo; child: ChildProcess }> {
  const dbUrl =
    config.database.mode === "postgres" && config.database.connectionString?.trim()
      ? config.database.connectionString.trim()
      : process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    throw new Error(
      "HIVE_CLI_SERVER_SUBPROCESS requires Postgres: set database.connectionString in hive.json or DATABASE_URL. Embedded Postgres is only supported with the default in-process server.",
    );
  }

  const host = config.server.host;
  const port = config.server.port;
  const healthUrl = `http://${host}:${port}/api/health`;
  const apiUrl = `http://${host}:${port}/api`;

  const child = spawn(process.execPath, [serverMainJs], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
    },
  });

  child.on("error", (err) => {
    console.error("[hive] server subprocess failed to start:", err);
  });

  try {
    await waitForHealth(healthUrl, 120_000);
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  }

  return {
    started: {
      apiUrl,
      databaseUrl: dbUrl,
      host,
      listenPort: port,
    },
    child,
  };
}

export async function waitForSubprocessExit(child: ChildProcess): Promise<void> {
  await once(child, "exit");
}
