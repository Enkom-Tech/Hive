import path from "node:path";
import { unprocessable } from "../../errors.js";
import { REDACTED_EVENT_VALUE } from "../../redaction.js";

export const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
  managed_worker: "instructionsFilePath",
};
export const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mergeAdapterConfigPreservingExistingEnv(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...patch };
  const existingEnv = asRecord(existing?.env);
  const patchEnv = asRecord(patch.env);
  if (!patchEnv) return merged;
  const mergedEnv: Record<string, unknown> = existingEnv ? { ...existingEnv } : {};
  for (const [key, patchBinding] of Object.entries(patchEnv)) {
    const binding = patchBinding as Record<string, unknown> | null;
    const isRedacted =
      binding &&
      typeof binding === "object" &&
      "value" in binding &&
      binding.value === REDACTED_EVENT_VALUE;
    if (isRedacted) {
      if (existingEnv && key in existingEnv) {
        mergedEnv[key] = existingEnv[key];
      } else {
        delete mergedEnv[key];
      }
    } else {
      mergedEnv[key] = patchBinding;
    }
  }
  merged.env = mergedEnv;
  return merged;
}

export function applyCreateDefaultsByAdapterType(
  _adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  return { ...adapterConfig };
}

export function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
  const trimmed = candidatePath.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  const cwd = asNonEmptyString(adapterConfig.cwd);
  if (!cwd) {
    throw unprocessable(
      "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  if (!path.isAbsolute(cwd)) {
    throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
  }
  return path.resolve(cwd, trimmed);
}

export function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
  const changedTopLevelKeys = Object.keys(patch).sort();
  const details: Record<string, unknown> = { changedTopLevelKeys };
  const adapterConfigPatch = asRecord(patch.adapterConfig);
  if (adapterConfigPatch) details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
  const runtimeConfigPatch = asRecord(patch.runtimeConfig);
  if (runtimeConfigPatch) details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
  return details;
}
