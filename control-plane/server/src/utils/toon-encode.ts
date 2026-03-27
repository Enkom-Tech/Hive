/**
 * Minimal TOON-style encoding for JSON-friendly values (DRONE-SPEC §8).
 * Sorted object keys and `key: value` lines; nested objects/arrays use newlines — not a full
 * [toonformat.dev](https://toonformat.dev) binary-safe spec. For worker-api, negotiation is
 * `HIVE_AGENT_PAYLOAD_FORMAT=toon`, `X-Hive-Agent-Payload-Format: toon`, or
 * `Accept: application/x-hive-toon` (see `worker-api-payload.ts`).
 */
export function encodeValueToToon(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => `[${i}]: ${encodeValueToToon(v)}`).join("\n");
  }
  const o = value as Record<string, unknown>;
  return Object.keys(o)
    .sort()
    .map((k) => `${k}: ${encodeValueToToon(o[k])}`)
    .join("\n");
}
