import type { Db } from "@hive/db";
import { agents } from "@hive/db";
import { eq } from "drizzle-orm";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import { getManagedWorkerExecuteDeps } from "../../adapters/managed-worker/execute-deps.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { logger } from "../../middleware/logger.js";
import { queuedRunHasFuturePlacementBackoff } from "../placement.js";
import { releaseRuntimeServicesForRun } from "../workspace-runtime.js";
import { createAdapterExecution } from "./adapter-execution.js";
import { createCostApplication } from "./cost-application.js";
import { createRunLifecycle } from "./run-lifecycle.js";

export type HeartbeatExecuteRunDeps = {
  db: Db;
  runLifecycle: ReturnType<typeof createRunLifecycle>;
  adapterExec: ReturnType<typeof createAdapterExecution>;
  costApp: ReturnType<typeof createCostApplication>;
};

export function createHeartbeatExecuteRun(deps: HeartbeatExecuteRunDeps) {
  const { db, runLifecycle, adapterExec, costApp } = deps;

  return async function executeRun(runId: string): Promise<void> {
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

      const {
        adapterResult,
        nextSessionState,
        stdoutExcerpt,
        stderrExcerpt,
        logSummary,
        taskKey,
      } = result;
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
  };
}
