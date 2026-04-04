import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import {
  accessService,
  agentService,
  companyPortabilityService,
  companyService,
} from "../../services/index.js";
import {
  registerCompanyCoreListStatsRoutesF,
  registerCompanyCoreDetailPortabilityCrudRoutesF,
} from "./company-core-routes.js";
import type { CompanyRouteOptions } from "./company-routes-context.js";
import {
  registerCompanyModelTrainingRoutesF,
  registerCompanyInferenceCatalogRoutesF,
  registerCompanyGatewayVirtualKeyRoutesF,
} from "./company-inference-gateway-routes.js";
import {
  registerCompanyWorkerInfraEarlyRoutesF,
  registerCompanyWorkerInstanceManagementRoutesF,
  registerCompanyWorkerDebugAndDeployRoutesF,
  registerCompanyWorkerInstanceDeleteRouteF,
} from "./company-worker-infra-routes.js";

export type { CompanyRouteOptions } from "./company-routes-context.js";

export async function companiesPlugin(
  fastify: FastifyInstance,
  opts: { db: Db } & CompanyRouteOptions,
): Promise<void> {
  const { db, ...routeOpts } = opts;
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);
  const agents = agentService(db, {
    drainAutoEvacuateEnabled: routeOpts.drainAutoEvacuateEnabled,
    drainCancelInFlightPlacementsEnabled: routeOpts.drainCancelInFlightPlacementsEnabled,
    workerIdentityAutomationEnabled: routeOpts.workerIdentityAutomationEnabled,
  });
  const deps = { db, routeOpts, svc, portability, access, agents };

  registerCompanyModelTrainingRoutesF(fastify, deps);
  registerCompanyCoreListStatsRoutesF(fastify, deps);
  registerCompanyWorkerInfraEarlyRoutesF(fastify, deps);
  registerCompanyCoreDetailPortabilityCrudRoutesF(fastify, deps);
  registerCompanyWorkerInstanceManagementRoutesF(fastify, deps);
  registerCompanyInferenceCatalogRoutesF(fastify, deps);
  registerCompanyWorkerDebugAndDeployRoutesF(fastify, deps);
  registerCompanyGatewayVirtualKeyRoutesF(fastify, deps);
  registerCompanyWorkerInstanceDeleteRouteF(fastify, deps);
}

