import { Router } from "express";
import type { Db } from "@hive/db";
import type { ApprovalServiceAdapterDeps } from "../../services/approvals.js";
import {
  activityService,
  agentService,
  accessService,
  approvalService,
  costService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
} from "../../services/index.js";
import {
  assertAdapterTypeAllowed,
  validateAdapterConfig,
} from "../../adapters/index.js";
import {
  assertCanCreateAgentsForCompany,
  normalizeAgentReference,
  type AgentRoutesCommonDeps,
} from "./common.js";
import { registerAgentListGetRoutes } from "./list-get.js";
import { registerAgentKeysRoutes } from "./keys.js";
import { registerAgentRunsRoutes } from "./runs.js";
import { registerAgentWorkerPairingRoutes } from "./pairing-routes.js";
import { registerAgentAdaptersRoutes } from "./adapters-routes.js";
import { registerAgentCrudRoutes } from "./crud-routes.js";
import { registerAgentRuntimeRoutes } from "./runtime-routes.js";
import { workerPairingService } from "../../services/worker-pairing.js";
import { workerPairingPublicRoutes } from "../worker-pairing-public.js";
import { getActorInfo } from "../authz.js";

export function agentRoutes(db: Db, opts: { strictSecretsMode: boolean }) {
  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = opts.strictSecretsMode;
  const approvalAdapterDeps: ApprovalServiceAdapterDeps = {
    secretService: secretsSvc,
    assertAdapterTypeAllowed,
    validateAdapterConfig,
    getStrictSecretsMode: () => strictSecretsMode,
  };
  const approvalsSvc = approvalService(db, approvalAdapterDeps);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const issueSvc = issueService(db);
  const activitySvc = activityService(db);
  const costSvc = costService(db);

  const commonDeps: AgentRoutesCommonDeps = { db, access, agentService: svc };

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId), commonDeps);
      next();
    } catch (err) {
      next(err);
    }
  });

  const logActivityBound = (input: Parameters<typeof logActivity>[1]) => logActivity(db, input);

  const pairingSvc = workerPairingService(db, {
    mintEnrollment: (agentId, ttl) => svc.createLinkEnrollmentToken(agentId, ttl),
  });

  router.use(workerPairingPublicRoutes(pairingSvc));

  registerAgentListGetRoutes(router, {
    ...commonDeps,
    heartbeatService: heartbeat,
    activityService: activitySvc,
    costService: costSvc,
    getActorInfo,
    logActivity: logActivityBound,
  });

  registerAgentKeysRoutes(router, {
    db,
    agentService: svc,
    getActorInfo,
    logActivity: logActivityBound,
  });

  registerAgentWorkerPairingRoutes(router, {
    db,
    agentService: svc,
    pairingSvc,
    logActivityBound,
  });

  registerAgentRunsRoutes(router, {
    db,
    heartbeatService: heartbeat,
    agentService: svc,
    issueService: issueSvc,
    logActivity: logActivityBound,
  });

  registerAgentAdaptersRoutes(router, {
    db,
    secretsSvc,
    strictSecretsMode,
    commonDeps,
  });

  registerAgentCrudRoutes(router, {
    db,
    svc,
    secretsSvc,
    strictSecretsMode,
    commonDeps,
    approvalsSvc,
    issueApprovalsSvc,
    heartbeat,
  });

  registerAgentRuntimeRoutes(router, {
    db,
    svc,
    heartbeat,
  });

  return router;
}
