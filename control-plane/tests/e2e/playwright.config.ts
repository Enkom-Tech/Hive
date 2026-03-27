import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.HIVE_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Defaults for local E2E only; override in CI via env. */
const DEFAULT_E2E_WORKER_JWT_SECRET = "hive-e2e-worker-jwt-secret-at-least-32-chars!!";
const DEFAULT_E2E_MCP_MATERIALIZE_SECRET = "hive-e2e-mcp-materialize-secret";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  /** Ensures onboarding creates an agent before z-mcp-worker-api-smoke (alphabetical file order). */
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // The webServer directive starts `hive run` before tests.
  // Expects `pnpm hive` to be runnable from repo root.
  webServer: {
    command: `pnpm hive run --yes`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !!process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HIVE_WORKER_JWT_SECRET: process.env.HIVE_WORKER_JWT_SECRET ?? DEFAULT_E2E_WORKER_JWT_SECRET,
      HIVE_E2E_MCP_MATERIALIZE_SECRET:
        process.env.HIVE_E2E_MCP_MATERIALIZE_SECRET ?? DEFAULT_E2E_MCP_MATERIALIZE_SECRET,
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
