import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { getWorkerLinkStableInstanceId, sendRunToWorker } from "../../workers/worker-link.js";
import { getManagedWorkerExecuteDeps } from "./execute-deps.js";
import { createWorkerAssignmentService } from "../../services/worker-assignment/index.js";
import {
  insertPendingRunPlacement,
  isWorkerInstanceDraining,
  markRunPlacementActive,
  markRunPlacementFailed,
  resolveAgentWorkerBinding,
  schedulePlacementDispatchRetry,
  workerInstanceAllowsSandboxPosture,
} from "../../services/placement.js";
import { logPlacementMetric } from "../../placement-metrics.js";

/** Logical LLM model id for this run (OpenAI-style `model` field / model-gateway routing). */
function resolveRunModelId(
  agent: { adapterConfig: unknown },
  context: Record<string, unknown>,
): string | undefined {
  const fromCtx =
    typeof context.model === "string"
      ? context.model.trim()
      : typeof context.modelId === "string"
        ? context.modelId.trim()
        : "";
  if (fromCtx) return fromCtx;
  const cfg =
    agent.adapterConfig && typeof agent.adapterConfig === "object" && agent.adapterConfig !== null
      ? (agent.adapterConfig as Record<string, unknown>)
      : {};
  const fromAgent =
    typeof cfg.model === "string" ? cfg.model.trim() : typeof cfg.modelId === "string" ? cfg.modelId.trim() : "";
  return fromAgent || undefined;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, context, adapterKey } = ctx;
  const deps = getManagedWorkerExecuteDeps();

  const payload: Record<string, unknown> = {
    type: "run",
    runId,
    agentId: agent.id,
    context,
  };
  if (adapterKey !== undefined) {
    payload.adapterKey = adapterKey;
  }
  const modelId = resolveRunModelId(agent, context);
  if (modelId !== undefined) {
    payload.modelId = modelId;
  }

  let placementId: string | null = null;

  let scheduling: { workerPlacementMode: string; operationalPosture: string; status: string } | null = null;
  if (deps) {
    scheduling = deps.loadAgentSchedulingRow
      ? await deps.loadAgentSchedulingRow(deps.db, agent.id)
      : null;
  }

  if (scheduling) {
    if (scheduling.operationalPosture === "archived" || scheduling.status === "terminated") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Agent is archived or terminated; new runs are not accepted.",
        errorCode: "AGENT_ARCHIVED",
        completionDeferred: false,
      };
    }
    if (scheduling.operationalPosture === "hibernate") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Agent is hibernating; wake or change posture before new runs.",
        errorCode: "HIBERNATE",
        completionDeferred: false,
      };
    }
  }

  let binding = deps ? await resolveAgentWorkerBinding(deps.db, agent.id) : null;

  if (deps && scheduling?.workerPlacementMode === "automatic") {
    if (!binding) {
      if (!deps.autoPlacementEnabled) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage:
            "Automatic placement is not enabled on this server (set HIVE_AUTO_PLACEMENT_ENABLED=true) or assign a drone manually.",
          errorCode: "AUTO_PLACEMENT_DISABLED",
          completionDeferred: false,
        };
      }
      const wa = createWorkerAssignmentService(deps.db);
      await wa.tryAutomaticBindForAgent(agent.id, agent.companyId);
      binding = await resolveAgentWorkerBinding(deps.db, agent.id);
    }
    if (!binding) {
      logPlacementMetric("placement_dispatch_failed", {
        reason: "no_eligible_drone",
        agentId: agent.id,
        runId,
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "No eligible drone instance for automatic placement (labels, drain, or empty pool).",
        errorCode: "NO_ELIGIBLE_DRONE",
        completionDeferred: false,
      };
    }
  }

  if (scheduling?.operationalPosture === "sandbox" && binding && deps) {
    const sandboxOk = await workerInstanceAllowsSandboxPosture(deps.db, binding.workerInstanceRowId);
    if (!sandboxOk) {
      logPlacementMetric("placement_dispatch_failed", {
        reason: "sandbox_binding_mismatch",
        agentId: agent.id,
        runId,
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          "Agent is in sandbox posture but is not assigned to a drone with labels.sandbox true; rebind on the Workers page.",
        errorCode: "SANDBOX_BINDING_MISMATCH",
        completionDeferred: false,
      };
    }
  }

  if (deps?.placementV1Enabled) {
    if (binding) {
      if (await isWorkerInstanceDraining(deps.db, binding.workerInstanceRowId)) {
        logPlacementMetric("placement_dispatch_failed", {
          reason: "draining",
          agentId: agent.id,
          runId,
        });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Worker instance is draining; new runs are not accepted.",
          errorCode: "DRAINING",
          completionDeferred: false,
        };
      }
      const linkRaw = getWorkerLinkStableInstanceId(agent.id);
      const linkStable = linkRaw?.trim().toLowerCase() ?? "";
      const boardStable = binding.stableInstanceId.trim().toLowerCase();
      if (linkStable.length > 0 && linkStable !== boardStable) {
        logPlacementMetric("placement_dispatch_failed", {
          reason: "connection_mismatch",
          agentId: agent.id,
          runId,
        });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage:
            "Connected worker does not match the worker instance bound to this agent on the board.",
          errorCode: "PLACEMENT_CONNECTION_MISMATCH",
          completionDeferred: false,
        };
      }
      try {
        placementId = await insertPendingRunPlacement(deps.db, {
          heartbeatRunId: runId,
          companyId: agent.companyId,
          agentId: agent.id,
          workerInstanceId: binding.workerInstanceRowId,
          policyVersion: "v1",
        });
        logPlacementMetric("placement_created", { placementId, runId, agentId: agent.id });
      } catch (err) {
        logPlacementMetric("placement_dispatch_failed", { reason: "insert_failed", runId, err });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Could not record run placement",
          errorCode: "PLACEMENT_PERSIST_FAILED",
          completionDeferred: false,
        };
      }
      payload.placementId = placementId;
      payload.expectedWorkerInstanceId = binding.stableInstanceId;
    }
  }

  const sent = sendRunToWorker(agent.id, payload as Parameters<typeof sendRunToWorker>[1]);

  if (!sent) {
    if (placementId && deps?.placementV1Enabled) {
      const retry = await schedulePlacementDispatchRetry(deps.db, placementId).catch(() => ({
        scheduled: false as const,
      }));
      if (retry.scheduled) {
        logPlacementMetric("placement_dispatch_retry_scheduled", {
          placementId,
          runId,
          nextAttemptAt: retry.nextAttemptAt?.toISOString() ?? null,
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          requeueRun: true,
          completionDeferred: false,
        };
      }
      await markRunPlacementFailed(deps.db, placementId, "NOT_CONNECTED").catch(() => {});
      logPlacementMetric("placement_dispatch_failed", { placementId, reason: "not_connected", runId });
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No worker connected for this agent",
      errorCode: "NO_WORKER",
      completionDeferred: false,
    };
  }

  if (placementId && deps?.placementV1Enabled) {
    await markRunPlacementActive(deps.db, placementId).catch(() => {});
    logPlacementMetric("placement_active", { placementId, runId });
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Run dispatched to worker",
    completionDeferred: true,
  };
}
