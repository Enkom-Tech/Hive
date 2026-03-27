import type { Db } from "@hive/db";
import { listPlacedHeartbeatRunsForWorkerInstance, markRunPlacementFailedForHeartbeatRun } from "./placement.js";
import { logger } from "../middleware/logger.js";

type CancelRunFn = (runId: string) => Promise<unknown>;

let cancelRunRef: CancelRunFn | null = null;

export function setDrainPlacementCancelRun(fn: CancelRunFn | null): void {
  cancelRunRef = fn;
}

/**
 * Cancel queued/running heartbeat runs bound to a draining worker instance and fail their placement rows.
 * Aligns with placement-in-flight-migration-policy (cancel + requeue via normal scheduler), not live migration.
 */
export async function cancelInFlightPlacementsForDrainingWorker(
  db: Db,
  workerInstanceId: string,
): Promise<{ cancelledRunIds: string[] }> {
  if (!cancelRunRef) {
    logger.warn("drain placement cancel: cancelRun not registered (heartbeat not bootstrapped yet)");
    return { cancelledRunIds: [] };
  }
  const rows = await listPlacedHeartbeatRunsForWorkerInstance(db, workerInstanceId);
  const cancelledRunIds: string[] = [];
  for (const r of rows) {
    try {
      await cancelRunRef(r.heartbeatRunId);
      cancelledRunIds.push(r.heartbeatRunId);
    } catch (err) {
      logger.warn({ err, runId: r.heartbeatRunId }, "drain: cancelRun failed");
    }
    await markRunPlacementFailedForHeartbeatRun(db, r.heartbeatRunId, "worker_draining");
  }
  return { cancelledRunIds };
}
