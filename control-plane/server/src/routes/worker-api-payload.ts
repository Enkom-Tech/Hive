import { encodeValueToToon } from "../utils/toon-encode.js";
import type { HeaderCarrier } from "./authz.js";

/** Global default from env (operator). */
function envWantsToon(): boolean {
  return process.env.HIVE_AGENT_PAYLOAD_FORMAT?.trim().toLowerCase() === "toon";
}

/**
 * Per-request TOON for worker-api success payloads (DRONE-SPEC §8).
 * Negotiation: env, or header X-Hive-Agent-Payload-Format: toon, or Accept containing application/x-hive-toon.
 */
export function wantsAgentPayloadToon(req: HeaderCarrier): boolean {
  if (envWantsToon()) {
    return true;
  }
  const fmt = req.headers["x-hive-agent-payload-format"]?.toString().trim().toLowerCase();
  if (fmt === "toon") {
    return true;
  }
  const accept = req.headers.accept?.toString().toLowerCase() ?? "";
  return accept.includes("application/x-hive-toon");
}

/** Canonical JSON body stored for worker-api idempotency (always JSON shape). */
export function workerApiSuccessJsonBody(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result };
}

/** HTTP response body for a successful worker-api call (JSON or TOON string in result). */
export function buildWorkerApiSuccessResponse(req: HeaderCarrier, result: unknown): { ok: true; result: unknown } | { ok: true; format: "toon"; result: string } {
  if (wantsAgentPayloadToon(req)) {
    return { ok: true, format: "toon", result: encodeValueToToon(result) };
  }
  return workerApiSuccessJsonBody(result);
}

/**
 * On idempotency replay, DB holds JSON `{ ok, result }`. Re-encode to TOON if the client negotiates it.
 */
export function adaptReplayedWorkerApiBody(
  req: HeaderCarrier,
  body: unknown,
): unknown {
  if (!wantsAgentPayloadToon(req) || body === null || typeof body !== "object") {
    return body;
  }
  const o = body as Record<string, unknown>;
  if (o.ok !== true || o.format === "toon") {
    return body;
  }
  if (!("result" in o)) {
    return body;
  }
  return { ok: true, format: "toon", result: encodeValueToToon(o.result) };
}
