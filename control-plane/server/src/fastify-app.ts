/**
 * Fastify application factory.
 *
 * This file mirrors the signature of createApp in app.ts so index.ts can
 * switch between implementations via the HIVE_USE_FASTIFY env flag.
 * Phases 2-4 fill this implementation out incrementally.
 */
import Fastify from "fastify";
import type { Db } from "@hive/db";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import type { StorageService } from "./storage/types.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { initPlacementPrometheus } from "./placement-metrics.js";

type UiMode = "none" | "static" | "vite-dev";

export type CreateAppOpts = {
  uiMode: UiMode;
  serverPort: number;
  storageService: StorageService;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  allowedHostnames: string[];
  bindHost: string;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  secretsStrictMode: boolean;
  secretsProvider: import("@hive/shared").SecretProvider;
  joinAllowedAdapterTypes: string[] | undefined;
  managedWorkerUrlAllowlist: string[] | undefined;
  corsAllowlist: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  metricsEnabled: boolean;
  drainAutoEvacuateEnabled: boolean;
  drainCancelInFlightPlacementsEnabled: boolean;
  vcsGitHubWebhookEnabled: boolean;
  vcsGitHubWebhookSecret: string | undefined;
  vcsGitHubAllowedRepos: string[] | undefined;
  workerIdentityAutomationEnabled?: boolean;
  apiPublicBaseUrl?: string;
  workerProvisionManifestJson?: string;
  workerProvisionManifestFile?: string;
  workerProvisionManifestSigningKeyPem?: string;
  internalHiveOperatorSecret?: string;
  pluginHostSecret?: string;
  e2eMcpSmokeMaterializeSecret?: string;
  bifrostAdminBaseUrl?: string;
  bifrostAdminToken?: string;
  authPublicBaseUrl?: string;
  authDisableSignUp: boolean;
  /** Fastify path — no longer an Express RequestHandler; wired directly in createFastifyApp. */
  betterAuthInstance?: unknown;
  resolveSession?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  principalResolver: import("./middleware/auth.js").PrincipalResolver;
  activeDatabaseConnectionString?: string;
};

export async function createFastifyApp(_db: Db, opts: CreateAppOpts) {
  initPlacementPrometheus(opts.metricsEnabled);

  const fastify = Fastify({
    logger: false, // pino integration wired in Phase 2
  });

  return fastify;
}
