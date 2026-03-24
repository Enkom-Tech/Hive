import { asNumber } from "../utils.js";

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300000;

/** @deprecated No longer used for execution; workers connect via WebSocket. Kept for compatibility. */
export function setManagedWorkerUrlAllowlist(_allowlist: string[]): void {
  // No-op: worker link uses WebSocket; worker connects to control plane.
}

export function validateManagedWorkerConfig(
  config: Record<string, unknown>,
  _options?: { companyId?: string },
): void {
  const timeoutMs = asNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `Managed worker adapter timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
}
