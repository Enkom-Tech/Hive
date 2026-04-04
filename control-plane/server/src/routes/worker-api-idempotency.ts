import { createHash } from "node:crypto";
import { badRequest } from "../errors.js";
import type { HeaderCarrier } from "./authz.js";

export const WORKER_API_IDEMPOTENCY_ROUTES = {
  issueCreate: "issue_create",
} as const;

const MAX_IDEMPOTENCY_KEY_LEN = 128;

/** Two 32-bit keys for `pg_advisory_xact_lock(int, int)`. */
export function workerApiIdempotencyAdvisoryKeys(
  companyId: string,
  agentId: string,
  route: string,
  idempotencyKey: string,
): [number, number] {
  const h = createHash("sha256")
    .update(companyId)
    .update("\0")
    .update(agentId)
    .update("\0")
    .update(route)
    .update("\0")
    .update(idempotencyKey)
    .digest();
  return [h.readInt32BE(0), h.readInt32BE(4)];
}

/**
 * Optional `X-Hive-Worker-Idempotency-Key`: printable ASCII, trimmed, max 128 chars.
 * Absent header → null. Present but empty/invalid → throws badRequest.
 */
export function parseWorkerApiIdempotencyKey(req: HeaderCarrier): string | null {
  const rawVal = req.headers["x-hive-worker-idempotency-key"];
  const raw = Array.isArray(rawVal) ? rawVal[0] : rawVal;
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v.length === 0) {
    throw badRequest("X-Hive-Worker-Idempotency-Key must not be empty");
  }
  if (v.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw badRequest(`X-Hive-Worker-Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LEN} characters`);
  }
  if (!/^[\x20-\x7E]+$/.test(v)) {
    throw badRequest("X-Hive-Worker-Idempotency-Key must be printable ASCII");
  }
  return v;
}