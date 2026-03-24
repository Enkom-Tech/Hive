#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const mode = process.argv[2] === "watch" ? "watch" : "dev";
const cliArgs = process.argv.slice(3);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
const forwardedArgs = [];

for (const arg of cliArgs) {
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}

const env = {
  ...process.env,
  HIVE_UI_DEV_MIDDLEWARE: "true",
};

if (tailscaleAuth) {
  env.HIVE_DEPLOYMENT_MODE = "authenticated";
  env.HIVE_DEPLOYMENT_EXPOSURE = "private";
  env.HIVE_AUTH_BASE_URL_MODE = "auto";
  env.HOST = "0.0.0.0";
  console.log("[hive] dev mode: authenticated/private (tailscale-friendly) on 0.0.0.0");
} else {
  console.log("[hive] dev mode: local_trusted (default)");
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function formatPendingMigrationSummary(migrations) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

async function runPnpm(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      shell: process.platform === "win32",
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrBuffer += String(chunk);
      });
    }

    child.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err ?? "pnpm spawn failed")));
    });
    child.on("exit", (code, signal) => {
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

async function maybePreflightMigrations() {
  if (mode !== "watch") return;
  if (process.env.HIVE_MIGRATION_PROMPT === "never") return;

  const status = await runPnpm(
    ["--filter", "@hive/db", "exec", "tsx", "src/migration-status.ts", "--json"],
    { env },
  );
  if (status.code !== 0) {
    process.stderr.write(status.stderr || status.stdout);
    process.exit(status.code);
  }

  let payload;
  try {
    payload = JSON.parse(status.stdout.trim());
  } catch (error) {
    process.stderr.write(status.stderr || status.stdout);
    throw error;
  }

  if (payload.status !== "needsMigrations" || payload.pendingMigrations.length === 0) {
    return;
  }

  const autoApply = process.env.HIVE_MIGRATION_AUTO_APPLY === "true";
  let shouldApply = autoApply;

  if (!autoApply) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(payload.pendingMigrations)}) now? (y/N): `,
          )
        )
          .trim()
          .toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) return;

  const migrate = spawn(pnpmBin, ["db:migrate"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  const exit = await new Promise((resolve) => {
    migrate.on("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }
}

try {
  await maybePreflightMigrations();
} catch (err) {
  console.error("[hive] dev-runner: migration preflight failed:", err);
  process.exit(1);
}

if (mode === "watch") {
  env.HIVE_MIGRATION_PROMPT = "never";
}

const serverScript = mode === "watch" ? "dev:watch" : "dev";
const child = spawn(
  pnpmBin,
  ["--filter", "@hive/server", serverScript, ...forwardedArgs],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);

child.on("error", (err) => {
  console.error("[hive] dev-runner: failed to start server process:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
