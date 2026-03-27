import { eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { companies } from "@hive/db";
import type { CreateAgentHire } from "@hive/shared";
import {
  assertAdapterTypeAllowed,
  validateAdapterConfig,
} from "../adapters/index.js";
import { REDACTED_EVENT_VALUE, redactEventPayload } from "../redaction.js";
import { notFound } from "../errors.js";
import {
  agentService,
  approvalService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import type { ApprovalServiceAdapterDeps } from "../services/approvals.js";
import { parseSourceIssueIds } from "./agents/common.js";

function applyCreateDefaultsByAdapterType(
  _adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  return { ...adapterConfig };
}

export async function runWorkerApiAgentHire(
  db: Db,
  opts: {
    strictSecretsMode: boolean;
    companyId: string;
    runId: string | null;
    body: CreateAgentHire & { agentId: string };
  },
) {
  const { strictSecretsMode, companyId, body, runId } = opts;
  const actingAgentId = body.agentId;
  const sourceIssueIds = parseSourceIssueIds(body);
  const { sourceIssueId: _a, sourceIssueIds: _b, agentId: _c, ...hireInput } = body;

  const svc = agentService(db);
  const secretsSvc = secretService(db);
  const approvalAdapterDeps: ApprovalServiceAdapterDeps = {
    secretService: secretsSvc,
    assertAdapterTypeAllowed,
    validateAdapterConfig,
    getStrictSecretsMode: () => strictSecretsMode,
  };
  const approvalsSvc = approvalService(db, approvalAdapterDeps);
  const issueApprovalsSvc = issueApprovalService(db);

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
    throw notFound("Company not found");
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
      redactEventPayload(((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>)) ?? {};
    approval = await approvalsSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: actingAgentId,
      requestedByUserId: null,
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
        requestedByAgentId: actingAgentId,
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
        agentId: actingAgentId,
        userId: null,
      });
    }
  }

  await logActivity(db, {
    companyId,
    actorType: "agent",
    actorId: actingAgentId,
    agentId: actingAgentId,
    runId,
    action: "worker_api.agent_hire",
    entityType: "agent",
    entityId: agent.id,
    details: {
      name: agent.name,
      role: agent.role,
      requiresApproval,
      approvalId: approval?.id ?? null,
      issueIds: sourceIssueIds,
      workerApi: true,
    },
  });
  if (approval) {
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: actingAgentId,
      agentId: actingAgentId,
      runId,
      action: "worker_api.approval_created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, linkedAgentId: agent.id, workerApi: true },
    });
  }

  return { agent, approval };
}
