import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveHiveHomeDir,
  resolveHiveInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.hive and default instance", () => {
    delete process.env.HIVE_HOME;
    delete process.env.HIVE_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".hive"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".hive", "instances", "default", "config.json"));
  });

  it("uses HIVE_HOME when set", () => {
    process.env.HIVE_HOME = "~/hive-home";
    expect(resolveHiveHomeDir()).toBe(path.resolve(os.homedir(), "hive-home"));
  });

  it("supports HIVE_HOME and explicit instance ids", () => {
    process.env.HIVE_HOME = "~/hive-home";

    const home = resolveHiveHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "hive-home"));
    expect(resolveHiveInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveHiveInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
