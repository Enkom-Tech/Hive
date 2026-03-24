import { Router } from "express";
import path from "node:path";
import type { Db } from "@hive/db";
import { companies } from "@hive/db";
import { eq } from "drizzle-orm";
import {
  createAgentHireSchema,
  createAgentSchema,
  openWorkerPairingWindowSchema,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
} from "@hive/shared";
import { validate } from "../../middleware/validate.js";
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
import { getCurrentPrincipal } from "../../auth/principal.js";
import { forbidden, unprocessable } from "../../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../authz.js";
import {
  assertAdapterTypeAllowed,
  findServerAdapter,
  listAdapterModels,
  listServerAdapters,
  validateAdapterConfig,
} from "../../adapters/index.js";
import { REDACTED_EVENT_VALUE, redactEventPayload } from "../../redaction.js";
import {
  assertCanCreateAgentsForCompany,
  assertCanUpdateAgent,
  normalizeAgentReference,
  parseSourceIssueIds,
  type AgentRoutesCommonDeps,
} from "./common.js";
import { registerAgentListGetRoutes } from "./list-get.js";
import { registerAgentKeysRoutes } from "./keys.js";
import { registerAgentRunsRoutes } from "./runs.js";
import { workerPairingService } from "../../services/worker-pairing.js";
import { workerPairingPublicRoutes } from "../worker-pairing-public.js";

const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
  managed_worker: "instructionsFilePath",
};
const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeAdapterConfigPreservingExistingEnv(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...patch };
  const existingEnv = asRecord(existing?.env);
  const patchEnv = asRecord(patch.env);
  if (!patchEnv) return merged;
  const mergedEnv: Record<string, unknown> = existingEnv ? { ...existingEnv } : {};
  for (const [key, patchBinding] of Object.entries(patchEnv)) {
    const binding = patchBinding as Record<string, unknown> | null;
    const isRedacted =
      binding &&
      typeof binding === "object" &&
      "value" in binding &&
      binding.value === REDACTED_EVENT_VALUE;
    if (isRedacted) {
      if (existingEnv && key in existingEnv) {
        mergedEnv[key] = existingEnv[key];
      } else {
        delete mergedEnv[key];
      }
    } else {
      mergedEnv[key] = patchBinding;
    }
  }
  merged.env = mergedEnv;
  return merged;
}

function applyCreateDefaultsByAdapterType(
  _adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  return { ...adapterConfig };
}

function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
  const trimmed = candidatePath.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  const cwd = asNonEmptyString(adapterConfig.cwd);
  if (!cwd) {
    throw unprocessable(
      "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  if (!path.isAbsolute(cwd)) {
    throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
  }
  return path.resolve(cwd, trimmed);
}

function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
  const changedTopLevelKeys = Object.keys(patch).sort();
  const details: Record<string, unknown> = { changedTopLevelKeys };
  const adapterConfigPatch = asRecord(patch.adapterConfig);
  if (adapterConfigPatch) details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
  const runtimeConfigPatch = asRecord(patch.runtimeConfig);
  if (runtimeConfigPatch) details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
  return details;
}

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

  const commonDeps: AgentRoutesCommonDeps = { access, agentService: svc };

  async function assertCanManageInstructionsPath(
    req: Parameters<typeof assertCompanyAccess>[0],
    targetAgent: { id: string; companyId: string },
  ) {
    assertCompanyAccess(req, targetAgent.companyId);
    const p = getCurrentPrincipal(req);
    if (p?.type === "user" || p?.type === "system") return;
    if (!p?.id || p?.type !== "agent") throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(p.id);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.id === targetAgent.id) return;
    const chainOfCommand = await svc.getChainOfCommand(targetAgent.id);
    if (chainOfCommand.some((manager) => manager.id === actorAgent.id)) return;
    throw forbidden("Only the target agent or an ancestor manager can update instructions path");
  }

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
    db,
    heartbeatService: heartbeat,
    activityService: activitySvc,
    costService: costSvc,
    assertBoard,
    assertCompanyAccess,
    getActorInfo,
    logActivity: logActivityBound,
  });

  registerAgentKeysRoutes(router, {
    agentService: svc,
    assertBoard,
    getActorInfo,
    logActivity: logActivityBound,
  });

  router.post(
    "/agents/:id/worker-pairing-window",
    validate(openWorkerPairingWindowSchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const id = req.params.id as string;
        const agent = await svc.getById(id);
        if (!agent) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        assertCompanyAccess(req, agent.companyId);
        const { ttlSeconds } = req.body as { ttlSeconds: number };
        const { expiresAt } = await pairingSvc.openPairingWindow(id, ttlSeconds);
        const actor = getActorInfo(req);
        await logActivityBound({
          companyId: agent.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "agent.worker_pairing_window_opened",
          entityType: "agent",
          entityId: agent.id,
          details: { expiresAt: expiresAt.toISOString() },
        });
        res.json({ expiresAt: expiresAt.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/companies/:companyId/worker-pairing-requests", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const requests = await pairingSvc.listPendingForCompany(companyId);
      res.json({ requests });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agents/:id/worker-pairing-requests/:requestId/approve", async (req, res, next) => {
    try {
      assertBoard(req);
      const id = req.params.id as string;
      const requestId = req.params.requestId as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      assertCompanyAccess(req, agent.companyId);
      const actor = getActorInfo(req);
      await pairingSvc.approveRequest({
        companyId: agent.companyId,
        agentId: agent.id,
        requestId,
        approvedByUserId: actor.actorId,
      });
      await logActivityBound({
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.worker_pairing_approved",
        entityType: "agent",
        entityId: agent.id,
        details: { requestId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agents/:id/worker-pairing-requests/:requestId/reject", async (req, res, next) => {
    try {
      assertBoard(req);
      const id = req.params.id as string;
      const requestId = req.params.requestId as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      assertCompanyAccess(req, agent.companyId);
      const actor = getActorInfo(req);
      await pairingSvc.rejectRequest({
        companyId: agent.companyId,
        agentId: agent.id,
        requestId,
        rejectedByUserId: actor.actorId,
      });
      await logActivityBound({
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.worker_pairing_rejected",
        entityType: "agent",
        entityId: agent.id,
        details: { requestId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  registerAgentRunsRoutes(router, {
    db,
    heartbeatService: heartbeat,
    agentService: svc,
    issueService: issueSvc,
    assertBoard,
    assertCompanyAccess,
    logActivity: logActivityBound,
  });

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = req.params.type as string;
    const models = await listAdapterModels(type);
    res.json(models);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = req.params.type as string;
      await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
      const adapter = findServerAdapter(type);
      if (!adapter) {
        res.status(404).json({ error: `Unknown adapter type: ${type}` });
        return;
      }
      const inputAdapterConfig = (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
      );
      const result = await adapter.testEnvironment({
        companyId,
        adapterType: type,
        config: runtimeAdapterConfig,
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/adapters", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const adapters = listServerAdapters().map((a) => ({
      type: a.type,
      label: a.type.replace(/_/g, " "),
      agentConfigurationDoc: a.agentConfigurationDoc ?? null,
    }));
    res.json({ adapters });
  });

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const { sourceIssueId: _sourceIssueId, sourceIssueIds: _sourceIssueIds, ...hireInput } = req.body;
    assertAdapterTypeAllowed(hireInput.adapterType);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.adapterType,
      (hireInput.adapterConfig ?? {}) as Record<string, unknown>,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      requestedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    await validateAdapterConfig(hireInput.adapterType, normalizedAdapterConfig, {
      companyId,
      resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg),
    });
    const normalizedHireInput = { ...hireInput, adapterConfig: normalizedAdapterConfig };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const agent = await svc.create(companyId, {
      ...normalizedHireInput,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (normalizedHireInput.adapterConfig ?? agent.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.agentId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: { name: agent.name, role: agent.role, requiresApproval, approvalId: approval?.id ?? null, issueIds: sourceIssueIds },
    });
    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }
    res.status(201).json({ agent, approval });
  });

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (getCurrentPrincipal(req)?.type === "agent") assertBoard(req);
    assertAdapterTypeAllowed(req.body.adapterType);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      req.body.adapterType,
      (req.body.adapterConfig ?? {}) as Record<string, unknown>,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      requestedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    await validateAdapterConfig(req.body.adapterType, normalizedAdapterConfig, {
      companyId,
      resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg),
    });
    const agent = await svc.create(companyId, {
      ...req.body,
      adapterConfig: normalizedAdapterConfig,
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: { name: agent.name, role: agent.role },
    });
    res.status(201).json(agent);
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const pConfig = getCurrentPrincipal(req);
    if (pConfig?.type === "agent") {
      const actorAgent = pConfig.id ? await svc.getById(pConfig.id) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (actorAgent.role !== "ceo") {
        res.status(403).json({ error: "Only CEO can manage permissions" });
        return;
      }
    }
    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: req.body,
    });
    res.json(agent);
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);
    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = DEFAULT_INSTRUCTIONS_PATH_KEYS[existing.adapterType] ?? null;
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }
    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
    }
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      nextAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(id, { adapterConfig: normalizedAdapterConfig }, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "instructions_path_patch",
      },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: { adapterConfigKey, path: pathValue, cleared: req.body.path === null },
    });
    res.json({ agentId: agent.id, adapterType: agent.adapterType, adapterConfigKey, path: pathValue });
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing, commonDeps);
    if (Object.prototype.hasOwnProperty.call(req.body, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }
    const patchData = { ...(req.body as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      const changingInstructionsPath = Object.keys(adapterConfig).some((k) => KNOWN_INSTRUCTIONS_PATH_KEYS.has(k));
      if (changingInstructionsPath) await assertCanManageInstructionsPath(req, existing);
      patchData.adapterConfig = adapterConfig;
    }
    const requestedAdapterType =
      typeof patchData.adapterType === "string" ? patchData.adapterType : existing.adapterType;
    const touchesAdapterConfiguration =
      Object.prototype.hasOwnProperty.call(patchData, "adapterType") ||
      Object.prototype.hasOwnProperty.call(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      assertAdapterTypeAllowed(requestedAdapterType);
      const rawEffectiveAdapterConfig = Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")
        ? mergeAdapterConfigPreservingExistingEnv(
            asRecord(existing.adapterConfig) ?? null,
            asRecord(patchData.adapterConfig) ?? {},
          )
        : (asRecord(existing.adapterConfig) ?? {});
      const effectiveAdapterConfig = applyCreateDefaultsByAdapterType(
        requestedAdapterType,
        rawEffectiveAdapterConfig,
      );
      const normalizedEffectiveAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        effectiveAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      await validateAdapterConfig(requestedAdapterType, normalizedEffectiveAdapterConfig, {
        companyId: existing.companyId,
        resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg),
      });
      patchData.adapterConfig = normalizedEffectiveAdapterConfig;
    }
    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });
    if (
      Object.prototype.hasOwnProperty.call(patchData, "workerPlacementMode") ||
      Object.prototype.hasOwnProperty.call(patchData, "operationalPosture")
    ) {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.worker_execution_policy_updated",
        entityType: "agent",
        entityId: agent.id,
        details: {
          workerPlacementMode: agent.workerPlacementMode,
          operationalPosture: agent.operationalPosture,
        },
      });
    }
    res.json(agent);
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await heartbeat.cancelActiveForAgent(id);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });
    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });
    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.terminate(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await heartbeat.cancelActiveForAgent(id);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });
    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });
    res.json({ ok: true });
  });

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const pWake = getCurrentPrincipal(req);
    if (pWake?.type === "agent" && pWake.id !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }
    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: pWake?.type === "agent" ? "agent" : "user",
      requestedByActorId: pWake?.type === "agent" ? pWake.id ?? null : pWake?.id ?? null,
      contextSnapshot: {
        triggeredBy: pWake?.type ?? "user",
        actorId: pWake?.type === "agent" ? pWake.id : pWake?.id,
      },
    });
    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });
    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const pWake = getCurrentPrincipal(req);
    if (pWake?.type === "agent" && pWake.id !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }
    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: pWake?.type ?? "user",
        actorId: pWake?.type === "agent" ? pWake.id : pWake?.id,
      },
      "manual",
      {
        actorType: pWake?.type === "agent" ? "agent" : "user",
        actorId: pWake?.type === "agent" ? pWake.id ?? null : pWake?.id ?? null,
      },
    );
    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });
    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    res.status(400).json({
      error: "Agent login is not supported for managed_worker adapter.",
    });
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });
    res.json(state);
  });

  return router;
}
