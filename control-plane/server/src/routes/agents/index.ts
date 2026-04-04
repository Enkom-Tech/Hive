import type { FastifyInstance } from "fastify";
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
  type AgentRoutesCommonDeps,
} from "./common.js";
import { registerAgentListGetRoutesF } from "./list-get.js";
import { registerAgentKeysRoutesF } from "./keys.js";
import { registerAgentRunsRoutesF } from "./runs.js";
import { registerAgentWorkerPairingRoutesF } from "./pairing-routes.js";
import { registerAgentAdaptersRoutesF } from "./adapters-routes.js";
import { registerAgentCrudRoutesF } from "./crud-routes.js";
import { registerAgentRuntimeRoutesF } from "./runtime-routes.js";
import { workerPairingService } from "../../services/worker-pairing.js";
import { getActorInfo } from "../authz.js";

export async function agentsPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; strictSecretsMode: boolean },
): Promise<void> {
  const { db, strictSecretsMode } = opts;
  const svc = agentService(db);
  const access = accessService(db);
  const secretsSvc = secretService(db);
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
  const logActivityBound = (input: Parameters<typeof logActivity>[1]) => logActivity(db, input);
  const pairingSvc = workerPairingService(db, {
    mintEnrollment: (agentId, ttl) => svc.createLinkEnrollmentToken(agentId, ttl),
  });

  registerAgentListGetRoutesF(fastify, {
    ...commonDeps,
    heartbeatService: heartbeat,
    activityService: activitySvc,
    costService: costSvc,
    getActorInfo,
    logActivity: logActivityBound,
  });

  registerAgentKeysRoutesF(fastify, {
    db,
    agentService: svc,
    getActorInfo,
    logActivity: logActivityBound,
  });

  registerAgentWorkerPairingRoutesF(fastify, {
    db,
    agentService: svc,
    pairingSvc,
    logActivityBound,
  });

  registerAgentRunsRoutesF(fastify, {
    db,
    heartbeatService: heartbeat,
    agentService: svc,
    issueService: issueSvc,
    logActivity: logActivityBound,
  });

  registerAgentAdaptersRoutesF(fastify, {
    db,
    secretsSvc,
    strictSecretsMode,
    commonDeps,
  });

  registerAgentCrudRoutesF(fastify, {
    db,
    svc,
    secretsSvc,
    strictSecretsMode,
    commonDeps,
    approvalsSvc,
    issueApprovalsSvc,
    heartbeat,
  });

  registerAgentRuntimeRoutesF(fastify, {
    db,
    svc,
    heartbeat,
  });
}
