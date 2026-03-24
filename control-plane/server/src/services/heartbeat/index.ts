import type { Db } from "@hive/db";
import { agents } from "@hive/db";
import { eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { getRunLogStore } from "../run-log-store.js";
import { publishLiveEvent } from "../live-events.js";
import { getServerAdapter } from "../../adapters/index.js";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import { runningProcesses } from "../../adapters/utils.js";
import { appendWithCap, MAX_EXCERPT_BYTES } from "../../adapters/utils.js";
import { sendCancelToWorker } from "../../workers/worker-link.js";
import { logPlacementMetric } from "../../placement-metrics.js";
import { issueService } from "../issues.js";
import { secretService } from "../secrets.js";
import {
  markRunPlacementFailedForHeartbeatRun,
  markRunPlacementTerminalCompleted,
  queuedRunHasFuturePlacementBackoff,
} from "../placement.js";
import { getManagedWorkerExecuteDeps } from "../../adapters/managed-worker/execute-deps.js";
import { releaseRuntimeServicesForRun } from "../workspace-runtime.js";
import { createRunLifecycle } from "./run-lifecycle.js";
import { createCostApplication } from "./cost-application.js";
import { createAdapterExecution, getDefaultSessionCodec } from "./adapter-execution.js";

export type { ResolvedWorkspaceForRun } from "./types.js";
export { resolveRuntimeSessionParamsForWorkspace, shouldResetTaskSessionForWake, isExternalRun } from "./types.js";

export function heartbeatService(db: Db) {
  const runLogStore = getRunLogStore();
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);

  const getSessionCodec = (adapterType: string) => {
    const adapter = getServerAdapter(adapterType);
    return adapter.sessionCodec ?? getDefaultSessionCodec();
  };

  const runLifecycle = createRunLifecycle({
    db,
    runLogStore: {
      read: runLogStore.read.bind(runLogStore),
      append: runLogStore.append.bind(runLogStore),
      finalize: runLogStore.finalize.bind(runLogStore),
    },
    publishLiveEvent: publishLiveEvent as (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void,
    getSessionCodec,
    onRunClaimed: (runId) => {
      void executeRun(runId).catch((err) => {
        logger.error({ err, runId }, "queued heartbeat execution failed");
      });
    },
    runningProcesses: {
      get: (runId) => {
        const r = runningProcesses.get(runId);
        if (!r) return undefined;
        return {
          child: {
            kill: (signal: string) => {
              r.child.kill(signal as NodeJS.Signals);
            },
            get killed() {
              return r.child.killed;
            },
          },
          graceSec: r.graceSec,
        };
      },
      has: (runId) => runningProcesses.has(runId),
      delete: (runId) => runningProcesses.delete(runId),
    },
    sendCancelToWorker,
  });

  const costApp = createCostApplication({ db });

  const adapterExec = createAdapterExecution({
    db,
    getRun: runLifecycle.getRun,
    getAgent: runLifecycle.getAgent,
    setRunStatus: runLifecycle.setRunStatus,
    appendRunEvent: runLifecycle.appendRunEvent,
    registerDeferredRunLogHandle: runLifecycle.registerDeferredRunLogHandle,
    finalizeAndRemoveRunLogHandle: runLifecycle.finalizeAndRemoveRunLogHandle,
    ensureRuntimeState: runLifecycle.ensureRuntimeState,
    getTaskSession: runLifecycle.getTaskSession,
    runLogStore: {
      begin: runLogStore.begin.bind(runLogStore),
      append: runLogStore.append.bind(runLogStore),
      finalize: runLogStore.finalize.bind(runLogStore),
    },
    getSessionCodec,
    issueService: issuesSvc,
    secretService: secretsSvc,
    publishLiveEvent: publishLiveEvent as (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void,
  });

  async function executeRun(runId: string): Promise<void> {
    let run = await runLifecycle.getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const placementDeps = getManagedWorkerExecuteDeps();
      if (placementDeps?.placementV1Enabled) {
        if (await queuedRunHasFuturePlacementBackoff(db, run.id)) return;
      }

      const schedulingGate = await db
        .select({
          operationalPosture: agents.operationalPosture,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .limit(1)
        .then((r) => r[0] ?? null);
      if (
        schedulingGate?.operationalPosture === "hibernate" ||
        schedulingGate?.operationalPosture === "archived" ||
        schedulingGate?.status === "terminated"
      ) {
        const isArchive =
          schedulingGate.status === "terminated" || schedulingGate.operationalPosture === "archived";
        await runLifecycle.setRunStatus(runId, "failed", {
          error: isArchive
            ? "Agent is archived or terminated; run not started."
            : "Agent is hibernating; wake or change posture before runs.",
          errorCode: isArchive ? "agent_archived" : "hibernate",
          finishedAt: new Date(),
        });
        await runLifecycle.setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: new Date(),
          error: isArchive ? "Agent archived or terminated" : "Agent hibernating",
        });
        const failedRun = await runLifecycle.getRun(runId);
        if (failedRun) await runLifecycle.releaseIssueExecutionAndPromote(failedRun);
        return;
      }

      const claimed = await runLifecycle.claimQueuedRun(run);
      if (!claimed) return;
      run = claimed;
    }

    const agent = await runLifecycle.getAgent(run.agentId);
    if (!agent) {
      await runLifecycle.setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await runLifecycle.setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await runLifecycle.getRun(runId);
      if (failedRun) await runLifecycle.releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    try {
      const result = await adapterExec.executeRunInvocation(runId);
      if (!result) return;
      if (result.completionDeferred) return;

      if (result.requeueRun) {
        run = await runLifecycle.getRun(runId);
        if (!run) return;
        const agentForRequeue = await runLifecycle.getAgent(run.agentId);
        if (!agentForRequeue) return;
        await runLifecycle.setRunStatus(runId, "queued", {
          startedAt: null,
          finishedAt: null,
          error: null,
          exitCode: null,
          signal: null,
          usageJson: null,
          resultJson: null,
          sessionIdBefore: null,
          sessionIdAfter: null,
          logStore: null,
          logRef: null,
          logBytes: null,
          logSha256: null,
          logCompressed: false,
          stdoutExcerpt: null,
          stderrExcerpt: null,
          errorCode: null,
        });
        await runLifecycle.setWakeupStatus(run.wakeupRequestId, "queued", {
          claimedAt: null,
          finishedAt: null,
          error: null,
        });
        await runLifecycle.finalizeAgentStatus(agentForRequeue.id, "succeeded");
        return;
      }

      const { adapterResult, nextSessionState, stdoutExcerpt, stderrExcerpt, logSummary, taskKey, previousSessionParams, previousSessionDisplayId } = result;
      run = await runLifecycle.getRun(runId);
      if (!run) return;

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await runLifecycle.getRun(runId);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        adapterResult.usage || adapterResult.costUsd != null
          ? ({
              ...(adapterResult.usage ?? {}),
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              ...(adapterResult.billingType ? { billingType: adapterResult.billingType } : {}),
            } as Record<string, unknown>)
          : null;

      await runLifecycle.setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await runLifecycle.setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await runLifecycle.getRun(run.id);
      if (finalizedRun) {
        const nextSeq = await runLifecycle.getNextRunEventSeq(runId);
        await runLifecycle.appendRunEvent(finalizedRun, nextSeq, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: { status, exitCode: adapterResult.exitCode },
        });
        await runLifecycle.releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        await costApp.updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        });
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await runLifecycle.clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await runLifecycle.upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }

      await runLifecycle.finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = redactCurrentUserText(err instanceof Error ? err.message : "Unknown adapter failure");
      logger.error({ err, runId }, "heartbeat execution failed");

      const run = await runLifecycle.getRun(runId);
      const agent = run ? await runLifecycle.getAgent(run.agentId) : null;
      const logSummary = await runLifecycle.finalizeAndRemoveRunLogHandle(runId);

      await runLifecycle.setRunStatus(runId, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      if (run) {
        await runLifecycle.setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: new Date(),
          error: message,
        });

        const failedRun = await runLifecycle.getRun(runId);
        if (failedRun) {
          const nextSeq = await runLifecycle.getNextRunEventSeq(runId);
          await runLifecycle.appendRunEvent(failedRun, nextSeq, {
            eventType: "error",
            stream: "system",
            level: "error",
            message,
          });
          await runLifecycle.releaseIssueExecutionAndPromote(failedRun);
        }

        if (agent && failedRun) {
          const syntheticResult: AdapterExecutionResult = {
            exitCode: null,
            signal: null,
            timedOut: false,
            errorMessage: message,
          };
          await costApp.updateRuntimeState(agent, failedRun, syntheticResult, {
            legacySessionId: null,
          });
        }

        await runLifecycle.finalizeAgentStatus(run.agentId, "failed");
      }

      await releaseRuntimeServicesForRun(runId);
    } finally {
      const run = await runLifecycle.getRun(runId);
      if (run) await runLifecycle.startNextQueuedRunForAgent(run.agentId);
    }
  }

  const WORKER_STATUS_MAX_TOKEN = 2 ** 31 - 1;
  const WORKER_STATUS_MAX_ERROR_SUMMARY_BYTES = 1000;
  const WORKER_STATUS_MAX_PROVIDER_MODEL_BYTES = 256;

  function sanitizeWorkerStatusPayload(payload: Record<string, unknown>) {
    const cap = (n: unknown, maxVal: number): number => {
      const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0;
      return Math.max(0, Math.min(maxVal, v));
    };
    const trim = (s: unknown, maxBytes: number): string => {
      const str = typeof s === "string" ? s : "";
      const encoded = new TextEncoder().encode(str);
      if (encoded.length <= maxBytes) return str;
      return new TextDecoder().decode(encoded.slice(0, maxBytes));
    };
    const usage =
      payload.usage && typeof payload.usage === "object" && payload.usage !== null
        ? (payload.usage as Record<string, unknown>)
        : {};
    const inputTokens = cap(usage.inputTokens, WORKER_STATUS_MAX_TOKEN);
    const outputTokens = cap(usage.outputTokens, WORKER_STATUS_MAX_TOKEN);
    const cachedInputTokens = cap(usage.cachedInputTokens, WORKER_STATUS_MAX_TOKEN);
    let costUsd = typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd) ? payload.costUsd : 0;
    if (costUsd < 0) costUsd = 0;
    const provider = trim(payload.provider, WORKER_STATUS_MAX_PROVIDER_MODEL_BYTES) || "unknown";
    const model = trim(payload.model, WORKER_STATUS_MAX_PROVIDER_MODEL_BYTES) || "unknown";
    const error = trim(payload.error, WORKER_STATUS_MAX_ERROR_SUMMARY_BYTES);
    const summary = trim(payload.summary, WORKER_STATUS_MAX_ERROR_SUMMARY_BYTES);
    const signal = typeof payload.signal === "string" ? payload.signal.slice(0, 32) : null;
    const exitCode = typeof payload.exitCode === "number" && Number.isFinite(payload.exitCode) ? payload.exitCode : null;
    const finishedAt = typeof payload.finishedAt === "string" ? payload.finishedAt : null;
    const resultJson =
      payload.resultJson && typeof payload.resultJson === "object" && payload.resultJson !== null
        ? (payload.resultJson as Record<string, unknown>)
        : null;
    const stdoutExcerpt =
      typeof payload.stdoutExcerpt === "string" ? appendWithCap("", payload.stdoutExcerpt, MAX_EXCERPT_BYTES) : null;
    const stderrExcerpt =
      typeof payload.stderrExcerpt === "string" ? appendWithCap("", payload.stderrExcerpt, MAX_EXCERPT_BYTES) : null;
    return {
      usage: { inputTokens, outputTokens, cachedInputTokens },
      costUsd,
      provider,
      model,
      error: error || null,
      summary: summary || null,
      signal,
      exitCode,
      finishedAt,
      resultJson,
      stdoutExcerpt,
      stderrExcerpt,
    };
  }

  async function handleWorkerRunStatus(
    agentId: string,
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const run = await runLifecycle.getRun(runId);
    if (!run || run.agentId !== agentId) return;
    if (run.status !== "running" && run.status !== "queued") return;

    const statusRaw = typeof payload.status === "string" ? payload.status : "";
    const runStatus =
      statusRaw === "done"
        ? "succeeded"
        : statusRaw === "failed"
          ? "failed"
          : statusRaw === "cancelled"
            ? "cancelled"
            : statusRaw === "running"
              ? "running"
              : null;
    if (runStatus === null) return;

    if (runStatus === "running") {
      await runLifecycle.setRunStatus(runId, "running", {});
      return;
    }

    await markRunPlacementTerminalCompleted(db, runId).catch(() => {});

    const sanitized = sanitizeWorkerStatusPayload(payload);
    const finishedAtDate = sanitized.finishedAt ? new Date(sanitized.finishedAt) : new Date();
    const usageJson =
      sanitized.usage.inputTokens > 0 ||
      sanitized.usage.outputTokens > 0 ||
      sanitized.usage.cachedInputTokens > 0 ||
      sanitized.costUsd > 0
        ? ({
            ...sanitized.usage,
            ...(sanitized.costUsd > 0 ? { costUsd: sanitized.costUsd } : {}),
          } as Record<string, unknown>)
        : null;

    const logSummary = await runLifecycle.finalizeAndRemoveRunLogHandle(runId);

    await runLifecycle.setRunStatus(runId, runStatus, {
      finishedAt: finishedAtDate,
      error: sanitized.error || null,
      exitCode: sanitized.exitCode,
      signal: sanitized.signal,
      usageJson,
      resultJson: sanitized.resultJson ?? (sanitized.summary ? { summary: sanitized.summary } : null),
      stdoutExcerpt: sanitized.stdoutExcerpt,
      stderrExcerpt: sanitized.stderrExcerpt,
      logBytes: logSummary?.bytes,
      logSha256: logSummary?.sha256,
      logCompressed: logSummary?.compressed ?? false,
    });

    const agent = await runLifecycle.getAgent(agentId);
    if (!agent) return;

    await runLifecycle.setWakeupStatus(run.wakeupRequestId, runStatus === "succeeded" ? "completed" : runStatus, {
      finishedAt: finishedAtDate,
      error: sanitized.error || null,
    });

    const finalizedRun = await runLifecycle.getRun(runId);
    if (finalizedRun) {
      const nextSeq = await runLifecycle.getNextRunEventSeq(runId);
      await runLifecycle.appendRunEvent(finalizedRun, nextSeq, {
        eventType: "lifecycle",
        stream: "system",
        level: runStatus === "succeeded" ? "info" : "error",
        message: `run ${runStatus}`,
        payload: { status: runStatus, exitCode: sanitized.exitCode },
      });
      await runLifecycle.releaseIssueExecutionAndPromote(finalizedRun);
    }

    const syntheticResult: AdapterExecutionResult = {
      exitCode: sanitized.exitCode ?? 0,
      signal: sanitized.signal,
      timedOut: false,
      errorMessage: sanitized.error || null,
      usage:
        sanitized.usage.inputTokens > 0 ||
        sanitized.usage.outputTokens > 0 ||
        sanitized.usage.cachedInputTokens > 0
          ? {
              inputTokens: sanitized.usage.inputTokens,
              outputTokens: sanitized.usage.outputTokens,
              cachedInputTokens: sanitized.usage.cachedInputTokens,
            }
          : undefined,
      costUsd: sanitized.costUsd > 0 ? sanitized.costUsd : undefined,
      provider: sanitized.provider,
      model: sanitized.model,
    };

    if (agent && finalizedRun) {
      await costApp.updateRuntimeState(agent, finalizedRun, syntheticResult, {
        legacySessionId: run.sessionIdAfter ?? run.sessionIdBefore ?? null,
      });
    }

    if (finalizedRun) {
      await runLifecycle.finalizeAgentStatus(agentId, runStatus);
      await runLifecycle.startNextQueuedRunForAgent(agentId);
    }
  }

  async function handleWorkerPlacementAck(agentId: string, payload: Record<string, unknown>): Promise<void> {
    const status = typeof payload.status === "string" ? payload.status : "";
    if (status !== "rejected") return;
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    if (!runId) return;
    const codeRaw = typeof payload.code === "string" ? payload.code : "rejected";
    const code = codeRaw.slice(0, 128);

    const run = await runLifecycle.getRun(runId);
    if (!run || run.agentId !== agentId) return;

    await markRunPlacementFailedForHeartbeatRun(db, runId, code);
    logPlacementMetric("placement_rejected", { runId, agentId, code });

    const logSummary = await runLifecycle.finalizeAndRemoveRunLogHandle(runId);
    const errMsg =
      code === "placement_mismatch"
        ? "Drone rejected run (placement mismatch)"
        : `Drone rejected run (${code})`;

    await runLifecycle.setRunStatus(runId, "failed", {
      finishedAt: new Date(),
      error: errMsg,
      errorCode: code,
      logBytes: logSummary?.bytes,
      logSha256: logSummary?.sha256,
      logCompressed: logSummary?.compressed ?? false,
    });

    await releaseRuntimeServicesForRun(runId).catch(() => {});

    const agent = await runLifecycle.getAgent(agentId);
    if (!agent) return;

    await runLifecycle.setWakeupStatus(run.wakeupRequestId, "failed", {
      finishedAt: new Date(),
      error: errMsg,
    });

    const finalizedRun = await runLifecycle.getRun(runId);
    if (finalizedRun) {
      const nextSeq = await runLifecycle.getNextRunEventSeq(runId);
      await runLifecycle.appendRunEvent(finalizedRun, nextSeq, {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: `placement rejected: ${code}`,
        payload: { code },
      });
      await runLifecycle.releaseIssueExecutionAndPromote(finalizedRun);
    }

    const syntheticResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errMsg,
      errorCode: code,
    };

    if (agent && finalizedRun) {
      await costApp.updateRuntimeState(agent, finalizedRun, syntheticResult, {
        legacySessionId: run.sessionIdAfter ?? run.sessionIdBefore ?? null,
      });
    }

    if (finalizedRun) {
      await runLifecycle.finalizeAgentStatus(agentId, "failed");
      await runLifecycle.startNextQueuedRunForAgent(agentId);
    }
  }

  async function tickTimers(now = new Date()) {
    const allAgents = await db.select().from(agents);
    let checked = 0;
    let enqueued = 0;
    let skipped = 0;

    for (const agent of allAgents) {
      if (
        agent.status === "paused" ||
        agent.status === "terminated" ||
        agent.status === "pending_approval"
      )
        continue;
      const policy = runLifecycle.parseHeartbeatPolicy(agent);
      if (!policy.enabled || policy.intervalSec <= 0) continue;

      checked += 1;
      const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
      const elapsedMs = now.getTime() - baseline;
      if (elapsedMs < policy.intervalSec * 1000) continue;

      const run = await runLifecycle.enqueueWakeup(agent.id, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
        contextSnapshot: {
          source: "scheduler",
          reason: "interval_elapsed",
          now: now.toISOString(),
        },
      });
      if (run) enqueued += 1;
      else skipped += 1;
    }

    return { checked, enqueued, skipped };
  }

  return {
    registerDeferredRunLogHandle: runLifecycle.registerDeferredRunLogHandle,
    appendWorkerRunLog: runLifecycle.appendWorkerRunLog,
    handleWorkerRunStatus,
    handleWorkerPlacementAck,
    list: runLifecycle.list,
    getRun: runLifecycle.getRun,
    ensureExternalRunForCheckout: runLifecycle.ensureExternalRunForCheckout,
    finishRunForIssueClosure: runLifecycle.finishRunForIssueClosure,
    touchRun: runLifecycle.touchRun,
    getRuntimeState: runLifecycle.getRuntimeState,
    listTaskSessions: runLifecycle.listTaskSessions,
    resetRuntimeSession: runLifecycle.resetRuntimeSession,
    listEvents: runLifecycle.listEvents,
    readLog: runLifecycle.readLog,
    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      runLifecycle.enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),
    wakeup: runLifecycle.enqueueWakeup,
    reapOrphanedRuns: runLifecycle.reapOrphanedRuns,
    tickTimers,
    executeRun,
    cancelRun: runLifecycle.cancelRun,
    cancelActiveForAgent: runLifecycle.cancelActiveForAgent,
    getActiveRunForAgent: runLifecycle.getActiveRunForAgent,
  };
}
