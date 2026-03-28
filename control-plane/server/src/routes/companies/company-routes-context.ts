import type { Db } from "@hive/db";
import {
  accessService,
  agentService,
  companyPortabilityService,
  companyService,
} from "../../services/index.js";

/** Options passed through from `register-main-api-routes` into company route registration. */
export type CompanyRouteOptions = {
  drainAutoEvacuateEnabled?: boolean;
  drainCancelInFlightPlacementsEnabled?: boolean;
  workerProvisionManifestJson?: string;
  workerProvisionManifestFile?: string;
  workerProvisionManifestSigningKeyPem?: string;
  workerIdentityAutomationEnabled?: boolean;
  /** Public API base URL for generated automation docs (e.g. https://board.example.com). */
  apiPublicBaseUrl?: string;
  bifrostAdmin?: { baseUrl: string; token: string };
  internalHiveOperatorSecret?: string;
};

export type CompanyRoutesDeps = {
  db: Db;
  routeOpts?: CompanyRouteOptions;
  svc: ReturnType<typeof companyService>;
  portability: ReturnType<typeof companyPortabilityService>;
  access: ReturnType<typeof accessService>;
  agents: ReturnType<typeof agentService>;
};
