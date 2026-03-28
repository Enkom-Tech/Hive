import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: serverDir,
  test: {
    environment: "node",
    setupFiles: [resolve(serverDir, "src/__tests__/helpers/access-service-mock.ts")],
    exclude: ["**/node_modules/**", "**/dist/**"],
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
  },
  coverage: {
    provider: "v8",
    include: ["src/**/*.ts"],
    exclude: [
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/node_modules/**",
    ],
    reporter: ["text", "lcov", "json-summary"],
    reportsDirectory: resolve(serverDir, "../coverage-server"),
    thresholds: {
      lines: 32,
      functions: 29,
      statements: 31,
      branches: 22,
    },
  },
});
