import type { Router, Request } from "express";
import type { Db } from "@hive/db";
import { companies } from "@hive/db";
import { eq } from "drizzle-orm";
import {
  createAgentHireSchema,
  createAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  updateAgentSchema,
  AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY,
} from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { forbidden } from "../../errors.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { redactEventPayload } from "../../redaction.js";
import {
  assertCanCreateAgentsForCompany,
  assertCanUpdateAgent,
  parseSourceIssueIds,
  type AgentRoutesCommonDeps,
} from "./common.js";
import { logActivity } from "../../services/index.js";
import {
  asRecord,
  asNonEmptyString,
  applyCreateDefaultsByAdapterType,
  DEFAULT_INSTRUCTIONS_PATH_KEYS,
  KNOWN_INSTRUCTIONS_PATH_KEYS,
  mergeAdapterConfigPreservingExistingEnv,
  resolveInstructionsFilePath,
  summarizeAgentUpdateDetails,
} from "./route-shared.js";

export type AgentCrudRoutesDeps = {
  db: Db;
  svc: ReturnType<typeof import("../../services/index.js").agentService>;
  secretsSvc: ReturnType<typeof import("../../services/index.js").secretService>;
  strictSecretsMode: boolean;
  commonDeps: AgentRoutesCommonDeps;
  approvalsSvc: ReturnType<typeof import("../../services/approvals.js").approvalService>;
  issueApprovalsSvc: ReturnType<typeof import("../../services/issue-approvals.js").issueApprovalService>;
  heartbeat: ReturnType<typeof import("../../services/index.js").heartbeatService>;
};

export function registerAgentCrudRoutes(router: Router, deps: AgentCrudRoutesDeps): void {
  const { db, svc, secretsSvc, strictSecretsMode, commonDeps, approvalsSvc, issueApprovalsSvc, heartbeat } = deps;

  async function assertCanManageInstructionsPath(
    req: Request,
    targetAgent: { id: string; companyId: string },
  ) {
    await assertCompanyRead(db, req, targetAgent.companyId);
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
    await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
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
    await assertCompanyRead(db, req, existing.companyId);
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
    } else if (pConfig?.type === "user") {
      await assertCompanyPermission(db, req, existing.companyId, "users:manage_permissions");
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
    const defaultModelSlugRaw = patchData.defaultModelSlug;
    if (Object.prototype.hasOwnProperty.call(patchData, "defaultModelSlug")) {
      delete patchData.defaultModelSlug;
      const baseRc = {
        ...((asRecord(existing.runtimeConfig) ?? {}) as Record<string, unknown>),
        ...((asRecord(patchData.runtimeConfig) ?? {}) as Record<string, unknown>),
      };
      if (defaultModelSlugRaw === null) {
        delete baseRc[AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY];
      } else if (typeof defaultModelSlugRaw === "string" && defaultModelSlugRaw.trim()) {
        baseRc[AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY] = defaultModelSlugRaw.trim();
      }
      patchData.runtimeConfig = baseRc;
    }
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
    const id = req.params.id as string;
    const existingPause = await svc.getById(id);
    if (!existingPause) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, existingPause.companyId, "agents:create");
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
    const id = req.params.id as string;
    const existingResume = await svc.getById(id);
    if (!existingResume) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, existingResume.companyId, "agents:create");
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
    const id = req.params.id as string;
    const existingTerm = await svc.getById(id);
    if (!existingTerm) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, existingTerm.companyId, "agents:create");
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
    const id = req.params.id as string;
    const existingDel = await svc.getById(id);
    if (!existingDel) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, existingDel.companyId, "agents:create");
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
}
