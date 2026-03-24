import type { CreateConfigValues } from "@hive/adapter-utils";

export function buildManagedWorkerConfig(v: CreateConfigValues): Record<string, unknown> {
  const raw = v as unknown as Record<string, unknown>;
  const rawTimeout = raw.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) ? rawTimeout : 15000;
  const runPath = raw.runPath;
  const out: Record<string, unknown> = {};
  if (timeoutMs >= 1000 && timeoutMs <= 300000) {
    out.timeoutMs = timeoutMs;
  }
  if (typeof runPath === "string" && runPath.trim()) out.runPath = runPath.trim();
  return out;
}
