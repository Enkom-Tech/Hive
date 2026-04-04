import type { FastifyInstance } from "fastify";
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

export function registerAgentCrudRoutesF(fastify: FastifyInstance, deps: AgentCrudRoutesDeps): void {
  const { db, svc, secretsSvc, strictSecretsMode, commonDeps, approvalsSvc, issueApprovalsSvc, heartbeat } = deps;

  async function assertCanManageInstructionsPathF(
    req: import("fastify").FastifyRequest,
    targetAgent: { id: string; companyId: string; adapterType: string },
  ) {
    await assertCompanyRead(db, req, targetAgent.companyId);
    const p = req.principal ?? null;
    if (p?.type === "user" || p?.type === "system") return;
    if (!p?.id || p?.type !== "agent") throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(p.id);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) throw forbidden("Agent key cannot access another company");
    if (actorAgent.id === targetAgent.id) return;
    const chainOfCommand = await svc.getChainOfCommand(targetAgent.id);
    if (chainOfCommand.some((manager) => manager.id === actorAgent.id)) return;
    throw forbidden("Only the target agent or an ancestor manager can update instructions path");
  }

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/agent-hires", async (req, reply) => {
    const { companyId } = req.params;
    await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
    const parsed = createAgentHireSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data;
    const sourceIssueIds = parseSourceIssueIds(body);
    const { sourceIssueId: _si, sourceIssueIds: _sis, ...hireInput } = body;
    assertAdapterTypeAllowed(hireInput.adapterType);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.adapterType,
      (hireInput.adapterConfig ?? {}) as Record<string, unknown>,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(companyId, requestedAdapterConfig, { strictMode: strictSecretsMode });
    await validateAdapterConfig(hireInput.adapterType, normalizedAdapterConfig, {
      companyId, resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg),
    });
    const normalizedHireInput = { ...hireInput, adapterConfig: normalizedAdapterConfig };
    const company = await db.select().from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const agent = await svc.create(companyId, { ...normalizedHireInput as unknown as Parameters<typeof svc.create>[1], status, spentMonthlyCents: 0, lastHeartbeatAt: null });
    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);
    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig = redactEventPayload((normalizedHireInput.adapterConfig ?? agent.adapterConfig) as Record<string, unknown>) ?? {};
      const requestedRuntimeConfig = redactEventPayload(((normalizedHireInput as Record<string, unknown>).runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>) ?? {};
      const requestedMetadata = redactEventPayload(((normalizedHireInput as Record<string, unknown>).metadata ?? agent.metadata ?? {}) as Record<string, unknown>) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: (normalizedHireInput as { title?: string | null }).title ?? null,
          icon: (normalizedHireInput as { icon?: string | null }).icon ?? null,
          reportsTo: (normalizedHireInput as { reportsTo?: string | null }).reportsTo ?? null,
          capabilities: (normalizedHireInput as { capabilities?: unknown }).capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents: typeof (normalizedHireInput as { budgetMonthlyCents?: number }).budgetMonthlyCents === "number" ? (normalizedHireInput as { budgetMonthlyCents: number }).budgetMonthlyCents : agent.budgetMonthlyCents,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: { adapterType: requestedAdapterType, adapterConfig: requestedAdapterConfig, runtimeConfig: requestedRuntimeConfig },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, { agentId: actor.actorType === "agent" ? actor.agentId : null, userId: actor.actorType === "user" ? actor.actorId : null });
      }
    }
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "agent.hire_created", entityType: "agent", entityId: agent.id, details: { name: agent.name, role: agent.role, requiresApproval, approvalId: approval?.id ?? null, issueIds: sourceIssueIds } });
    if (approval) await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "approval.created", entityType: "approval", entityId: approval.id, details: { type: approval.type, linkedAgentId: agent.id } });
    return reply.status(201).send({ agent, approval });
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/agents", async (req, reply) => {
    const { companyId } = req.params;
    await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data;
    assertAdapterTypeAllowed(body.adapterType);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(body.adapterType, (body.adapterConfig ?? {}) as Record<string, unknown>);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(companyId, requestedAdapterConfig, { strictMode: strictSecretsMode });
    await validateAdapterConfig(body.adapterType, normalizedAdapterConfig, { companyId, resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg) });
    const agent = await svc.create(companyId, { ...(body as unknown as Parameters<typeof svc.create>[1]), adapterConfig: normalizedAdapterConfig, status: "idle", spentMonthlyCents: 0, lastHeartbeatAt: null });
    const actor = getActorInfo(req);
    await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "agent.created", entityType: "agent", entityId: agent.id, details: { name: agent.name, role: agent.role } });
    return reply.status(201).send(agent);
  });

  fastify.patch<{ Params: { id: string } }>("/api/agents/:id/permissions", async (req, reply) => {
    const { id } = req.params;
    const parsed = updateAgentPermissionsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, existing.companyId);
    const p = req.principal ?? null;
    if (p?.type === "agent") {
      const actorAgent = p.id ? await svc.getById(p.id) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) return reply.status(403).send({ error: "Forbidden" });
      if (actorAgent.role !== "ceo") return reply.status(403).send({ error: "Only CEO can manage permissions" });
    } else if (p?.type === "user") {
      await assertCompanyPermission(db, req, existing.companyId, "users:manage_permissions");
    }
    const agent = await svc.updatePermissions(id, parsed.data);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "agent.permissions_updated", entityType: "agent", entityId: agent.id, details: parsed.data });
    return reply.send(agent);
  });

  fastify.patch<{ Params: { id: string } }>("/api/agents/:id/instructions-path", async (req, reply) => {
    const { id } = req.params;
    const parsed = updateAgentInstructionsPathSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCanManageInstructionsPathF(req, existing);
    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const body = parsed.data as { adapterConfigKey?: string; path: string | null };
    const explicitKey = asNonEmptyString(body.adapterConfigKey);
    const defaultKey = DEFAULT_INSTRUCTIONS_PATH_KEYS[existing.adapterType] ?? null;
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) return reply.status(422).send({ error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.` });
    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (body.path === null) { delete nextAdapterConfig[adapterConfigKey]; }
    else { nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(body.path, existingAdapterConfig); }
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(existing.companyId, nextAdapterConfig, { strictMode: strictSecretsMode });
    const actor = getActorInfo(req);
    const agent = await svc.update(id, { adapterConfig: normalizedAdapterConfig }, { recordRevision: { createdByAgentId: actor.agentId, createdByUserId: actor.actorType === "user" ? actor.actorId : null, source: "instructions_path_patch" } });
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);
    await logActivity(db, { companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "agent.instructions_path_updated", entityType: "agent", entityId: agent.id, details: { adapterConfigKey, path: pathValue, cleared: body.path === null } });
    return reply.send({ agentId: agent.id, adapterType: agent.adapterType, adapterConfigKey, path: pathValue });
  });

  fastify.patch<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const { id } = req.params;
    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCanUpdateAgent(req, existing, commonDeps);
    const patchData = { ...(parsed.data as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(patchData, "permissions")) return reply.status(422).send({ error: "Use /api/agents/:id/permissions for permission changes" });
    const defaultModelSlugRaw = patchData.defaultModelSlug;
    if (Object.prototype.hasOwnProperty.call(patchData, "defaultModelSlug")) {
      delete patchData.defaultModelSlug;
      const baseRc = { ...((asRecord(existing.runtimeConfig) ?? {}) as Record<string, unknown>), ...((asRecord(patchData.runtimeConfig) ?? {}) as Record<string, unknown>) };
      if (defaultModelSlugRaw === null) { delete baseRc[AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY]; }
      else if (typeof defaultModelSlugRaw === "string" && defaultModelSlugRaw.trim()) { baseRc[AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY] = defaultModelSlugRaw.trim(); }
      patchData.runtimeConfig = baseRc;
    }
    if (Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) return reply.status(422).send({ error: "adapterConfig must be an object" });
      const changingInstructionsPath = Object.keys(adapterConfig).some((k) => KNOWN_INSTRUCTIONS_PATH_KEYS.has(k));
      if (changingInstructionsPath) await assertCanManageInstructionsPathF(req, existing);
      patchData.adapterConfig = adapterConfig;
    }
    const requestedAdapterType = typeof patchData.adapterType === "string" ? patchData.adapterType : existing.adapterType;
    const touchesAdapterConfiguration = Object.prototype.hasOwnProperty.call(patchData, "adapterType") || Object.prototype.hasOwnProperty.call(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      assertAdapterTypeAllowed(requestedAdapterType);
      const rawEffectiveAdapterConfig = Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")
        ? mergeAdapterConfigPreservingExistingEnv(asRecord(existing.adapterConfig) ?? null, asRecord(patchData.adapterConfig) ?? {})
        : (asRecord(existing.adapterConfig) ?? {});
      const effectiveAdapterConfig = applyCreateDefaultsByAdapterType(requestedAdapterType, rawEffectiveAdapterConfig);
      const normalizedEffectiveAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(existing.companyId, effectiveAdapterConfig, { strictMode: strictSecretsMode });
      await validateAdapterConfig(requestedAdapterType, normalizedEffectiveAdapterConfig, { companyId: existing.companyId, resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg) });
      patchData.adapterConfig = normalizedEffectiveAdapterConfig;
    }
    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, { recordRevision: { createdByAgentId: actor.agentId, createdByUserId: actor.actorType === "user" ? actor.actorId : null, source: "patch" } });
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await logActivity(db, { companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "agent.updated", entityType: "agent", entityId: agent.id, details: summarizeAgentUpdateDetails(patchData) });
    if (Object.prototype.hasOwnProperty.call(patchData, "workerPlacementMode") || Object.prototype.hasOwnProperty.call(patchData, "operationalPosture")) {
      await logActivity(db, { companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: "agent.worker_execution_policy_updated", entityType: "agent", entityId: agent.id, details: { workerPlacementMode: agent.workerPlacementMode, operationalPosture: agent.operationalPosture } });
    }
    return reply.send(agent);
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req, reply) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, existing.companyId, "agents:create");
    const agent = await svc.pause(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await heartbeat.cancelActiveForAgent(id);
    const p = req.principal ?? null;
    await logActivity(db, { companyId: agent.companyId, actorType: "user", actorId: p?.id ?? "board", action: "agent.paused", entityType: "agent", entityId: agent.id });
    return reply.send(agent);
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req, reply) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, existing.companyId, "agents:create");
    const agent = await svc.resume(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const p = req.principal ?? null;
    await logActivity(db, { companyId: agent.companyId, actorType: "user", actorId: p?.id ?? "board", action: "agent.resumed", entityType: "agent", entityId: agent.id });
    return reply.send(agent);
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/terminate", async (req, reply) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, existing.companyId, "agents:create");
    const agent = await svc.terminate(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await heartbeat.cancelActiveForAgent(id);
    const p = req.principal ?? null;
    await logActivity(db, { companyId: agent.companyId, actorType: "user", actorId: p?.id ?? "board", action: "agent.terminated", entityType: "agent", entityId: agent.id });
    return reply.send(agent);
  });

  fastify.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const { id } = req.params;
    const existing = await svc.getById(id);
    if (!existing) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, existing.companyId, "agents:create");
    const agent = await svc.remove(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    const p = req.principal ?? null;
    await logActivity(db, { companyId: agent.companyId, actorType: "user", actorId: p?.id ?? "board", action: "agent.deleted", entityType: "agent", entityId: agent.id });
    return reply.send({ ok: true });
  });
}
