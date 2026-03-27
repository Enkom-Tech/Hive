import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/__tests__/helpers/access-service-mock.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
