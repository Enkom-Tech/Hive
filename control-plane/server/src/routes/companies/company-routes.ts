import { Router } from "express";
import type { Db } from "@hive/db";
import {
  accessService,
  agentService,
  companyPortabilityService,
  companyService,
} from "../../services/index.js";
import {
  registerCompanyCoreDetailPortabilityCrudRoutes,
  registerCompanyCoreListStatsRoutes,
} from "./company-core-routes.js";
import type { CompanyRouteOptions } from "./company-routes-context.js";
import {
  registerCompanyGatewayVirtualKeyRoutes,
  registerCompanyInferenceCatalogRoutes,
  registerCompanyModelTrainingRoutes,
} from "./company-inference-gateway-routes.js";
import {
  registerCompanyWorkerDebugAndDeployRoutes,
  registerCompanyWorkerInfraEarlyRoutes,
  registerCompanyWorkerInstanceDeleteRoute,
  registerCompanyWorkerInstanceManagementRoutes,
} from "./company-worker-infra-routes.js";

export type { CompanyRouteOptions } from "./company-routes-context.js";

export function companyRoutes(db: Db, routeOpts?: CompanyRouteOptions) {
  const router = Router();
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);
  const agents = agentService(db, {
    drainAutoEvacuateEnabled: routeOpts?.drainAutoEvacuateEnabled,
    drainCancelInFlightPlacementsEnabled: routeOpts?.drainCancelInFlightPlacementsEnabled,
    workerIdentityAutomationEnabled: routeOpts?.workerIdentityAutomationEnabled,
  });
  const deps = { db, routeOpts, svc, portability, access, agents };

  registerCompanyModelTrainingRoutes(router, deps);
  registerCompanyCoreListStatsRoutes(router, deps);
  registerCompanyWorkerInfraEarlyRoutes(router, deps);
  registerCompanyCoreDetailPortabilityCrudRoutes(router, deps);
  registerCompanyWorkerInstanceManagementRoutes(router, deps);
  registerCompanyInferenceCatalogRoutes(router, deps);
  registerCompanyWorkerDebugAndDeployRoutes(router, deps);
  registerCompanyGatewayVirtualKeyRoutes(router, deps);
  registerCompanyWorkerInstanceDeleteRoute(router, deps);

  return router;
}
