import { describe, expect, it } from "vitest";
import { secretsCheck } from "../checks/secrets-check.js";
import type { HiveConfig } from "../config/schema.js";

function baseConfig(): HiveConfig {
  return {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
    llm: undefined,
    database: {
      mode: "embedded-postgres",
      connectionString: undefined,
      embeddedPostgresDataDir: "/tmp/db",
      embeddedPostgresPort: 54329,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: "/tmp/backups" },
    },
    logging: { mode: "file", logDir: "/tmp/logs" },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      authProvider: "builtin",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", publicBaseUrl: undefined, disableSignUp: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/storage" },
      s3: { bucket: "hive", region: "us-east-1", endpoint: undefined, prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/master.key" },
      vault: { kvMount: "hive" },
    },
  };
}

describe("secretsCheck", () => {
  it("fails vault when required env is missing", () => {
    const config = baseConfig();
    config.secrets.provider = "vault";
    const result = secretsCheck(config);
    expect(result.status).toBe("fail");
  });
});
