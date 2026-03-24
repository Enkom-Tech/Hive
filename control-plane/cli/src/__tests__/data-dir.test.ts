import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDataDirOverride } from "../config/data-dir.js";

const ORIGINAL_ENV = { ...process.env };

describe("applyDataDirOverride", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.HIVE_HOME;
    delete process.env.HIVE_HOME;
    delete process.env.HIVE_CONFIG;
    delete process.env.HIVE_CONTEXT;
    delete process.env.HIVE_INSTANCE_ID;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("sets HIVE_HOME and HIVE_HOME and isolated default config/context paths", () => {
    const home = applyDataDirOverride({
      dataDir: "~/hive-data",
      config: undefined,
      context: undefined,
    }, { hasConfigOption: true, hasContextOption: true });

    const expectedHome = path.resolve(os.homedir(), "hive-data");
    const expectedConfig = path.resolve(expectedHome, "instances", "default", "config.json");
    const expectedContext = path.resolve(expectedHome, "context.json");
    expect(home).toBe(expectedHome);
    expect(process.env.HIVE_HOME).toBe(expectedHome);
    expect(process.env.HIVE_HOME).toBe(expectedHome);
    expect(process.env.HIVE_CONFIG).toBe(expectedConfig);
    expect(process.env.HIVE_CONFIG).toBe(expectedConfig);
    expect(process.env.HIVE_CONTEXT).toBe(expectedContext);
    expect(process.env.HIVE_CONTEXT).toBe(expectedContext);
    expect(process.env.HIVE_INSTANCE_ID).toBe("default");
    expect(process.env.HIVE_INSTANCE_ID).toBe("default");
  });

  it("uses the provided instance id when deriving default config path", () => {
    const home = applyDataDirOverride({
      dataDir: "/tmp/hive-alt",
      instance: "dev_1",
      config: undefined,
      context: undefined,
    }, { hasConfigOption: true, hasContextOption: true });

    const expectedConfig = path.resolve("/tmp/hive-alt", "instances", "dev_1", "config.json");
    expect(home).toBe(path.resolve("/tmp/hive-alt"));
    expect(process.env.HIVE_INSTANCE_ID).toBe("dev_1");
    expect(process.env.HIVE_INSTANCE_ID).toBe("dev_1");
    expect(process.env.HIVE_CONFIG).toBe(expectedConfig);
    expect(process.env.HIVE_CONFIG).toBe(expectedConfig);
  });

  it("does not override explicit config/context settings", () => {
    process.env.HIVE_CONFIG = "/env/config.json";
    process.env.HIVE_CONTEXT = "/env/context.json";

    applyDataDirOverride({
      dataDir: "/tmp/hive-alt",
      config: "/flag/config.json",
      context: "/flag/context.json",
    }, { hasConfigOption: true, hasContextOption: true });

    expect(process.env.HIVE_CONFIG).toBe("/env/config.json");
    expect(process.env.HIVE_CONTEXT).toBe("/env/context.json");
  });

  it("only applies defaults for options supported by the command", () => {
    applyDataDirOverride(
      {
        dataDir: "/tmp/hive-alt",
      },
      { hasConfigOption: false, hasContextOption: false },
    );

    expect(process.env.HIVE_HOME).toBe(path.resolve("/tmp/hive-alt"));
    expect(process.env.HIVE_CONFIG).toBeUndefined();
    expect(process.env.HIVE_CONFIG).toBeUndefined();
    expect(process.env.HIVE_CONTEXT).toBeUndefined();
    expect(process.env.HIVE_CONTEXT).toBeUndefined();
  });
});
