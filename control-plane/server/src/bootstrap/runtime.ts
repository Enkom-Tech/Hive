import type { Server as HttpServer } from "node:http";
import type { Db } from "@hive/db";
import { agents as agentsTable } from "@hive/db";
import { eq } from "drizzle-orm";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { setManagedWorkerExecuteDeps } from "../adapters/managed-worker/execute-deps.js";
import { attachWorkerLinkUpgrade, trySendJsonToWorkerInstance } from "../workers/worker-link.js";
import { initWorkerDeliveryRedis } from "../workers/worker-delivery-redis.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { agentService, heartbeatService, reconcilePersistedRuntimeServicesOnStartup } from "../services/index.js";
import { logger } from "../middleware/logger.js";

export interface RuntimeBootstrapResult {
  heartbeat: ReturnType<typeof heartbeatService>;
}

export async function bootstrapRuntime(
  server: HttpServer,
  db: Db,
  config: Config,
  opts: {
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<RuntimeBootstrapResult> {
  const heartbeat = heartbeatService(db as any);
  const agents = agentService(db as Db, {
    workerIdentityAutomationEnabled: config.workerIdentityAutomationEnabled,
    drainAutoEvacuateEnabled: config.drainAutoEvacuateEnabled,
  });

  setManagedWorkerExecuteDeps({
    db: db as Db,
    placementV1Enabled: config.placementV1Enabled,
    autoPlacementEnabled: config.autoPlacementEnabled,
    loadAgentSchedulingRow: async (dbConn, agentId) => {
      const row = await dbConn
        .select({
          workerPlacementMode: agentsTable.workerPlacementMode,
          operationalPosture: agentsTable.operationalPosture,
          status: agentsTable.status,
        })
        .from(agentsTable)
        .where(eq(agentsTable.id, agentId))
        .limit(1)
        .then((r) => r[0] ?? null);
      return row;
    },
  });

  const instanceLinkTtlSeconds = 90 * 24 * 3600;
  attachWorkerLinkUpgrade(server, {
    db: db as any,
    heartbeat: {
      appendWorkerRunLog: heartbeat.appendWorkerRunLog.bind(heartbeat),
      handleWorkerRunStatus: heartbeat.handleWorkerRunStatus.bind(heartbeat),
      handleWorkerPlacementAck: heartbeat.handleWorkerPlacementAck.bind(heartbeat),
    },
    mintInstanceLinkToken: (companyId, workerInstanceId) =>
      agents.createWorkerInstanceLinkEnrollmentToken(companyId, workerInstanceId, instanceLinkTtlSeconds, {
        maxTtlSeconds: instanceLinkTtlSeconds,
      }),
    reconcileAutomaticAssignmentsForCompany: (companyId) => agents.reconcileAutomationForCompany(companyId),
  });

  initWorkerDeliveryRedis(config.workerDeliveryBusUrl, trySendJsonToWorkerInstance);

  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });

  return { heartbeat };
}

