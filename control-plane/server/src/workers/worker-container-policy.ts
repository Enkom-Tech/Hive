import { createHmac } from "node:crypto";

/**
 * Matches infra/worker/internal/policyoverlay.ApplySignedAllowlist:
 * HMAC-SHA256(secret, version + "|" + allowlistCsv + "|" + expiresAt), hex signature.
 */
export type WorkerContainerPolicyBroadcastConfig = {
  secret: string;
  allowlistCsv: string;
  version: string;
  expiresAt: string;
};

export function signWorkerContainerPolicyPayload(
  secret: string,
  version: string,
  allowlistCsv: string,
  expiresAt: string,
): string {
  const v = version.trim();
  const al = allowlistCsv.trim();
  const ex = expiresAt.trim();
  const payload = `${v}|${al}|${ex}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function tryBuildWorkerContainerPolicyMessage(
  cfg: WorkerContainerPolicyBroadcastConfig | undefined,
): { type: string; version: string; allowlistCsv: string; expiresAt: string; signature: string } | null {
  if (!cfg) return null;
  const secret = cfg.secret.trim();
  const allowlistCsv = cfg.allowlistCsv.trim();
  const version = cfg.version.trim() || "1";
  const expiresAt = cfg.expiresAt.trim();
  if (!secret || !allowlistCsv) return null;
  const signature = signWorkerContainerPolicyPayload(secret, version, allowlistCsv, expiresAt);
  return {
    type: "worker_container_policy",
    version,
    allowlistCsv,
    expiresAt,
    signature,
  };
}
