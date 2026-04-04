import { Router } from "express";
import type { Db } from "@hive/db";
import type { CreateAppOpts } from "../fastify-app.js";
import type { StorageService } from "../storage/types.js";
import { workloadService } from "../services/workload.js";
import { healthRoutes } from "./health.js";
import { releaseRoutes } from "./releases.js";
import { workerDownloadsRoutes } from "./worker-downloads.js";
import { workerApiMetricsMiddleware } from "../middleware/worker-api-metrics.js";
import { workerApiRoutes } from "./worker-api/index.js";
import {
  internalHiveOperatorRoutes,
  internalHiveTrainingCallbackRoutes,
} from "./internal-hive.js";
import { pluginHostRoutes } from "./plugin-host.js";
import { e2eMcpSmokeRoutes } from "./e2e-mcp-smoke.js";
import { createCompanyEventsSSEHandler } from "./events-sse.js";
import { companyRoutes } from "./companies/index.js";
import { agentRoutes } from "./agents/index.js";
import { assetRoutes } from "./assets.js";
import { projectRoutes } from "./projects.js";
import { issueRoutes } from "./issues.js";
import { goalRoutes } from "./goals.js";
import { approvalRoutes } from "./approvals.js";
import { secretRoutes } from "./secrets.js";
import { costRoutes } from "./costs.js";
import { activityRoutes } from "./activity.js";
import { dashboardRoutes } from "./dashboard.js";
import { standupRoutes } from "./standup.js";
import { workloadRoutes } from "./workload.js";
import { webhookDeliveryRoutes } from "./webhook-deliveries.js";
import { connectRoutes } from "./connect.js";
import { sidebarBadgeRoutes } from "./sidebar-badges.js";
import { pluginBoardRoutes } from "./plugins.js";
import { accessRoutes } from "./access.js";
import { departmentRoutes } from "./departments.js";
import { instanceRoutes } from "./instance.js";
import { instanceStatusRoutes } from "./instance-status.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { renderPlacementPrometheusScrape } from "../placement-metrics.js";

/**
 * Mounts all standard `/api` routers (everything under the `api` Router created in createApp).
 * Centralizes registration so new domains do not require editing app.ts middleware/CORS sections.
 */
export function registerMainApiRoutes(
  api: Router,
  db: Db,
  storageService: StorageService,
  opts: CreateAppOpts,
): void {
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      authDisableSignUp: opts.authDisableSignUp,
    }),
  );
  if (opts.metricsEnabled) {
    api.get("/metrics", async (_req, res) => {
      const out = await renderPlacementPrometheusScrape();
      if (!out) {
        res.status(503).json({ error: "Metrics unavailable" });
        return;
      }
      res.status(200).set("Content-Type", out.contentType).send(out.body);
    });
  }
  api.use("/releases", releaseRoutes());
  api.use(
    "/worker-downloads",
    workerDownloadsRoutes({
      authPublicBaseUrl: opts.authPublicBaseUrl,
      workerProvisionManifestJson: opts.workerProvisionManifestJson,
      workerProvisionManifestFile: opts.workerProvisionManifestFile,
      workerProvisionManifestSigningKeyPem: opts.workerProvisionManifestSigningKeyPem,
    }),
  );
  api.use(
    "/worker-api",
    workerApiMetricsMiddleware(),
    workerApiRoutes(db, { secretsStrictMode: opts.secretsStrictMode }),
  );
  api.use(
    "/internal/hive",
    internalHiveTrainingCallbackRoutes(db, {
      internalOperatorSecret: opts.internalHiveOperatorSecret?.trim(),
    }),
  );
  if (opts.internalHiveOperatorSecret?.trim()) {
    api.use(
      "/internal/hive",
      internalHiveOperatorRoutes(db, { operatorSecret: opts.internalHiveOperatorSecret.trim() }),
    );
  }
  if (opts.pluginHostSecret?.trim()) {
    api.use(
      "/internal/plugin-host",
      pluginHostRoutes(db, { hostSecret: opts.pluginHostSecret.trim() }),
    );
  }
  if (opts.deploymentMode === "local_trusted" && opts.e2eMcpSmokeMaterializeSecret?.trim()) {
    api.use(
      "/e2e/mcp-smoke",
      e2eMcpSmokeRoutes(db, {
        materializeSecret: opts.e2eMcpSmokeMaterializeSecret.trim(),
        serverPort: opts.serverPort,
      }),
    );
  }
  api.get(
    "/companies/:companyId/events",
    createCompanyEventsSSEHandler(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  api.use(
    "/companies",
    companyRoutes(db, {
      drainAutoEvacuateEnabled: opts.drainAutoEvacuateEnabled,
      drainCancelInFlightPlacementsEnabled: opts.drainCancelInFlightPlacementsEnabled,
      workerIdentityAutomationEnabled: opts.workerIdentityAutomationEnabled ?? true,
      apiPublicBaseUrl: opts.apiPublicBaseUrl,
      workerProvisionManifestJson: opts.workerProvisionManifestJson,
      workerProvisionManifestFile: opts.workerProvisionManifestFile,
      workerProvisionManifestSigningKeyPem: opts.workerProvisionManifestSigningKeyPem,
      bifrostAdmin:
        opts.bifrostAdminBaseUrl?.trim() && opts.bifrostAdminToken?.trim()
          ? { baseUrl: opts.bifrostAdminBaseUrl.trim(), token: opts.bifrostAdminToken.trim() }
          : undefined,
      internalHiveOperatorSecret: opts.internalHiveOperatorSecret,
    }),
  );
  api.use(agentRoutes(db, { strictSecretsMode: opts.secretsStrictMode }));
  api.use(assetRoutes(db, storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, storageService));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db, opts.secretsStrictMode));
  api.use(secretRoutes(db, opts.secretsProvider));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(standupRoutes(db));
  api.use(workloadRoutes(db));
  api.use(webhookDeliveryRoutes(db));
  api.use(connectRoutes(db, { authPublicBaseUrl: opts.authPublicBaseUrl }));
  api.use(sidebarBadgeRoutes(db));
  api.use(pluginBoardRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
      joinAllowedAdapterTypes: opts.joinAllowedAdapterTypes,
    }),
  );
  api.use(departmentRoutes(db));
  api.use("/instance", instanceRoutes(db, { deploymentMode: opts.deploymentMode }));
  api.use(
    "/instance",
    instanceStatusRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      authDisableSignUp: opts.authDisableSignUp,
      activeDatabaseConnectionString: opts.activeDatabaseConnectionString,
      metricsEnabled: opts.metricsEnabled,
      workload: workloadService(db),
    }),
  );
}
