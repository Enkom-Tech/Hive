import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config.js";

describe("config validation (fail-fast)", () => {
  const originalEnv: NodeJS.ProcessEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when NODE_ENV=production and an unknown env var is present", () => {
    process.env.NODE_ENV = "production";
    process.env.UNKNOWN_VAR_FOR_FAIL_FAST = "x";

    expect(() => loadConfig()).toThrow(
      /Unknown environment variable.*UNKNOWN_VAR_FOR_FAIL_FAST/,
    );
  });

  it("throws when deployment mode is authenticated and no auth secret is set", () => {
    process.env.HIVE_DEPLOYMENT_MODE = "authenticated";
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.HIVE_AGENT_JWT_SECRET;

    expect(() => loadConfig()).toThrow(
      /authenticated mode requires BETTER_AUTH_SECRET or HIVE_AGENT_JWT_SECRET/,
    );
  });

  it("throws when database mode is postgres and DATABASE_URL is missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-config-test-"));
    const configPath = path.join(tmpDir, "config.json");
    const minimalPostgresConfig = {
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" as const },
      database: { mode: "postgres" as const },
      logging: { mode: "file" as const },
      server: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(minimalPostgresConfig), "utf-8");
    try {
      process.env.HIVE_CONFIG = configPath;
      delete process.env.DATABASE_URL;

      expect(() => loadConfig()).toThrow(
        /database mode is postgres but DATABASE_URL is missing or empty/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
