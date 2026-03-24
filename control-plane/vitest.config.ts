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
      thresholds: {
        lines: 50,
        functions: 50,
        statements: 50,
        "server/src/services/**": { lines: 50 },
        "server/src/routes/**": { lines: 50 },
        "server/src/auth/**": { lines: 50 },
      },
    },
  },
});
