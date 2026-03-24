import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultConfigPath,
  resolveDefaultContextPath,
  resolveHiveInstanceId,
} from "./home.js";

export interface DataDirOptionLike {
  dataDir?: string;
  config?: string;
  context?: string;
  instance?: string;
}

export interface DataDirCommandSupport {
  hasConfigOption?: boolean;
  hasContextOption?: boolean;
}

export function applyDataDirOverride(
  options: DataDirOptionLike,
  support: DataDirCommandSupport = {},
): string | null {
  const rawDataDir = options.dataDir?.trim();
  if (!rawDataDir) return null;

  const resolvedDataDir = path.resolve(expandHomePrefix(rawDataDir));
  process.env.HIVE_HOME = resolvedDataDir;

  if (support.hasConfigOption) {
    const hasConfigOverride = Boolean(options.config?.trim()) || Boolean(process.env.HIVE_CONFIG);
    if (!hasConfigOverride) {
      const instanceId = resolveHiveInstanceId(options.instance);
      process.env.HIVE_INSTANCE_ID = instanceId;
      const configPath = resolveDefaultConfigPath(instanceId);
      process.env.HIVE_CONFIG = configPath;
    }
  }

  if (support.hasContextOption) {
    const hasContextOverride = Boolean(options.context?.trim()) || Boolean(process.env.HIVE_CONTEXT);
    if (!hasContextOverride) {
      const contextPath = resolveDefaultContextPath();
      process.env.HIVE_CONTEXT = contextPath;
    }
  }

  return resolvedDataDir;
}
