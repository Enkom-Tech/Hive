import fs from "node:fs";
import { hiveConfigSchema, type HiveConfig } from "@hive/shared";
import { resolveHiveConfigPath } from "./paths.js";

export function readConfigFile(): HiveConfig | null {
  const configPath = resolveHiveConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return hiveConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
