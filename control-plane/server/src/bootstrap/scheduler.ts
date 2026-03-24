import type { Db } from "@hive/db";
import type { Config } from "../config.js";
import { runDatabaseBackup, formatDatabaseBackupResult } from "@hive/db";
import { logger } from "../middleware/logger.js";
import { tickPlacementRetrySweep } from "./placement-retry-sweep.js";
import { listCompanyIdsWithActiveWorkerIdentitySlots } from "../services/worker-identity-reconcile.js";
import { agentService } from "../services/agents.js";

export function setupSchedulers(input: {
  config: Config;
  db: Db;
  heartbeat: {
    reapOrphanedRuns: (opts?: { staleThresholdMs?: number }) => Promise<unknown>;
    tickTimers: (now: Date) => Promise<{ enqueued: number }>;
    executeRun: (runId: string) => Promise<void>;
  };
  activeDatabaseConnectionString: string;
}): void {
  const { config, db, heartbeat, activeDatabaseConnectionString } = input;

  if (config.heartbeatSchedulerEnabled) {
    // Reap orphaned runs at startup (no threshold -- runningProcesses is empty)
    void heartbeat.reapOrphanedRuns().catch((err: unknown) => {
      logger.error({ err }, "startup reap of orphaned heartbeat runs failed");
    });

    setInterval(() => {
      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err: unknown) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      // Periodically reap orphaned runs (5-min staleness threshold)
      void heartbeat
        .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
        .catch((err: unknown) => {
          logger.error({ err }, "periodic reap of orphaned heartbeat runs failed");
        });
    }, config.heartbeatSchedulerIntervalMs);
  }

  if (config.placementV1Enabled) {
    const sweepMs = Math.max(10_000, Math.min(120_000, config.heartbeatSchedulerIntervalMs));
    setInterval(() => {
      void tickPlacementRetrySweep(db, heartbeat.executeRun).catch((err: unknown) => {
        logger.error({ err }, "placement retry sweep tick failed");
      });
    }, sweepMs);
  }

  if (config.workerAutomationReconcileIntervalMs > 0 && config.workerIdentityAutomationEnabled) {
    const automationMs = Math.max(30_000, config.workerAutomationReconcileIntervalMs);
    const automationAgents = agentService(db, {
      drainAutoEvacuateEnabled: config.drainAutoEvacuateEnabled,
      workerIdentityAutomationEnabled: config.workerIdentityAutomationEnabled,
    });
    setInterval(() => {
      void (async () => {
        try {
          const companyIds = await listCompanyIdsWithActiveWorkerIdentitySlots(db);
          for (const companyId of companyIds) {
            await automationAgents.reconcileAutomationForCompany(companyId);
          }
        } catch (err: unknown) {
          logger.error({ err }, "worker automation periodic reconcile failed");
        }
      })();
    }, automationMs);
  }

  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;

    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }

      backupInFlight = true;
      try {
        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "hive",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err: unknown) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );

    setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }
}

