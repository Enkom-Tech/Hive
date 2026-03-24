import type { Db } from "@hive/db";
import { logger } from "../middleware/logger.js";
import { listDuePlacementRetries } from "../services/placement.js";

/**
 * Periodically nudge heartbeat runs whose placement v1 row is due for another dispatch attempt.
 * Claiming the run remains atomic in heartbeat (only one replica proceeds per run).
 */
export async function tickPlacementRetrySweep(
  db: Db,
  executeRun: (runId: string) => Promise<void>,
): Promise<{ due: number }> {
  const rows = await listDuePlacementRetries(db, 40);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.heartbeatRunId)) continue;
    seen.add(r.heartbeatRunId);
    void executeRun(r.heartbeatRunId).catch((err: unknown) => {
      logger.error({ err, runId: r.heartbeatRunId }, "placement retry sweep executeRun failed");
    });
  }
  if (rows.length > 0) {
    logger.info({ due: seen.size }, "placement retry sweep invoked executeRun for due placements");
  }
  return { due: seen.size };
}
