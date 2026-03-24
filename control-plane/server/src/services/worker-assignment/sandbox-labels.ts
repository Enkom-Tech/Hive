/** Drone row is eligible for `operational_posture = sandbox` when `labels.sandbox === true`. */
export function workerInstanceLabelsAllowSandboxPosture(labels: unknown): boolean {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return false;
  return (labels as Record<string, unknown>).sandbox === true;
}
