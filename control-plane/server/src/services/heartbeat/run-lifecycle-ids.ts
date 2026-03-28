/** UUID v1–v5 shape check for heartbeat run ids (DB primary keys). */
export const HEARTBEAT_RUN_ID_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidFormattedRunId(runId: string): boolean {
  return HEARTBEAT_RUN_ID_UUID_REGEX.test(String(runId ?? "").trim());
}
