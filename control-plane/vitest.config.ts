import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/db", "packages/shared", "server", "ui", "cli"],
    coverage: {
      provider: "v8",
      include: [
        "server/src/**/*.ts",
        "cli/src/**/*.ts",
        "ui/src/**/*.ts",
        "packages/db/src/**/*.ts",
        "packages/shared/src/**/*.ts",
      ],
      exclude: [
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/node_modules/**",
      ],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // No global thresholds: merged server+CLI+UI+packages coverage is far below a single
      // sensible gate. Re-introduce thresholds on a server-only Vitest project (or exclude UI
      // from `include`) before ratcheting. See doc/CONTROL-PLANE-SCALING-AND-HA.md.
    },
  },
});
