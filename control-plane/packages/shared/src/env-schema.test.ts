import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseEnv, KNOWN_ENV_KEYS } from "./env-schema.js";

describe("env-schema", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parseEnv returns parsed env with known keys", () => {
    process.env.HIVE_HOME = "/tmp/hive";
    process.env.PORT = "3100";
    const parsed = parseEnv(process.env, { strictUnknown: false });
    expect(parsed.HIVE_HOME).toBe("/tmp/hive");
    expect(parsed.PORT).toBe("3100");
  });

  it("parseEnv with strictUnknown false allows unknown keys", () => {
    process.env.UNKNOWN_VAR = "x";
    const parsed = parseEnv(process.env, { strictUnknown: false });
    expect(parsed.HIVE_HOME).toBeUndefined();
  });

  it("parseEnv with strictUnknown true throws on unknown key", () => {
    const env = { HIVE_HOME: "/tmp", SOME_UNKNOWN_VAR: "x" };
    expect(() => parseEnv(env, { strictUnknown: true })).toThrow(
      /Unknown environment variable.*SOME_UNKNOWN_VAR/,
    );
  });

  it("parseEnv with strictUnknown true accepts known keys only", () => {
    const env = { HIVE_HOME: "/tmp/hive", PORT: "3100" };
    const parsed = parseEnv(env, { strictUnknown: true });
    expect(parsed.HIVE_HOME).toBe("/tmp/hive");
    expect(parsed.PORT).toBe("3100");
  });

  it("parseEnv with strictUnknown true accepts passthrough keys", () => {
    const env = { PATH: "/usr/bin", NODE_ENV: "production" };
    const parsed = parseEnv(env, { strictUnknown: true });
    expect(parsed.NODE_ENV).toBe("production");
  });

  it("KNOWN_ENV_KEYS contains expected server and passthrough keys", () => {
    expect(KNOWN_ENV_KEYS.has("HIVE_HOME")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("PORT")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("DATABASE_URL")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("BETTER_AUTH_SECRET")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("PATH")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("NODE_ENV")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("HIVE_BIFROST_ADMIN_BASE_URL")).toBe(true);
    expect(KNOWN_ENV_KEYS.has("UNKNOWN_KEY")).toBe(false);
  });
});
