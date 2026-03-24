/**
 * Single process-boundary module for server env: reads process.env, validates with Zod, exports typed config.
 * This is the only place in the server that reads process.env for config-related keys.
 */

import {
  parseEnv,
  KNOWN_ENV_KEYS,
  ENV_VAR_DOCS,
  type ParsedEnv,
} from "@hive/shared";

/**
 * Read and validate process.env. In production (NODE_ENV=production), throws on unknown env keys.
 * Call only after dotenv has been loaded (e.g. from config.ts top-level).
 */
export function getEnvConfig(): ParsedEnv {
  const strictUnknown = process.env.NODE_ENV === "production";
  return parseEnv(process.env, { strictUnknown });
}

export { KNOWN_ENV_KEYS, ENV_VAR_DOCS };
export type { ParsedEnv };
