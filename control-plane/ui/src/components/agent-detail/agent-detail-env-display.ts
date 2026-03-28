import { redactHomePathUserSegments, redactHomePathUserSegmentsInValue } from "@hive/adapter-utils";
import { redactEnvValue as redactEnvValueForDisplay } from "../../pages/agent-detail/env-redaction.js";
import { asRecord } from "./agent-detail-parsing.js";

function redactEnvValue(key: string, value: unknown): string {
  return redactEnvValueForDisplay(key, value, redactHomePathUserSegments, redactHomePathUserSegmentsInValue);
}

export function formatEnvForDisplay(envValue: unknown): string {
  const env = asRecord(envValue);
  if (!env) return "<unable-to-parse>";

  const keys = Object.keys(env);
  if (keys.length === 0) return "<empty>";

  return keys
    .sort()
    .map((key) => `${key}=${redactEnvValue(key, env[key])}`)
    .join("\n");
}
