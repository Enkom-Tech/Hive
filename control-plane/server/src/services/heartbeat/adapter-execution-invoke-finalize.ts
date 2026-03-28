import { eq } from "drizzle-orm";
import { agents } from "@hive/db";
import type { AdapterInvocationMeta } from "../../adapters/index.js";
import { getServerAdapter } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { logger } from "../../middleware/logger.js";
import type { RunLogHandle } from "../run-log-store.js";
import { formatProductionPoliciesForRun } from "../production-policies-for-run.js";
import {
  buildWorkspaceReadyComment,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  releaseRuntimeServicesForRun,
} from "../workspace-runtime.js";
import { resolveNextSessionState } from "./adapter-execution-prelude.js";
import type { AdapterExecutionDeps, ExecuteRunInvocationResult } from "./adapter-execution-types.js";
import type { AdapterInvocationPrepareResult } from "./adapter-execution-invoke-prepare.js";
import { appendExcerpt, MAX_LIVE_LOG_CHUNK_BYTES, readNonEmptyString } from "./types.js";

export async function finalizeAdapterInvocationExecute(
  deps: AdapterExecutionDeps,
  runId: string,
  agent: NonNullable<Awaited<ReturnType<AdapterExecutionDeps["getAgent"]>>>,
  prepared: AdapterInvocationPrepareResult,
  run: NonNullable<Awaited<ReturnType<AdapterExecutionDeps["getRun"]>>>,
): Promise<ExecuteRunInvocationResult | null> {
  const {
    db,
    getRun,
    setRunStatus,
    appendRunEvent,
    registerDeferredRunLogHandle,
    finalizeAndRemoveRunLogHandle,
    runLogStore,
    issueService: issuesSvc,
    publishLiveEvent,
  } = deps;

  const {
    context,
    taskKey,
    sessionCodec,
    issueId,
    issueRef,
    executionProjectId,
    executionDepartmentId,
    executionWorkspace,
    resolvedConfig,
    secretKeys,
    runtimeForAdapter,
    previousSessionParams,
    runtimeWorkspaceWarnings,
  } = prepared;

  let seq = 1;
  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";

  const startedAt = run.startedAt ?? new Date();
  await setRunStatus(runId, "running", {
    startedAt,
    sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
    contextSnapshot: context,
  });

  await db
    .update(agents)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  publishLiveEvent({
    companyId: agent.companyId,
    type: "agent.status",
    payload: { agentId: agent.id, status: "running", outcome: "running" },
  });

  let currentRun = await getRun(runId);
  if (!currentRun) return null;
  await appendRunEvent(currentRun, seq++, {
    eventType: "lifecycle",
    stream: "system",
    level: "info",
    message: "run started",
  });

  handle = await runLogStore.begin({
    companyId: currentRun.companyId,
    agentId: currentRun.agentId,
    runId,
  });
  registerDeferredRunLogHandle(runId, handle);

  await setRunStatus(runId, "running", {
    logStore: handle.store,
    logRef: handle.logRef,
  });

  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    const sanitizedChunk = redactCurrentUserText(chunk);
    if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
    if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
    const ts = new Date().toISOString();
    await runLogStore.append(handle!, { stream, chunk: sanitizedChunk, ts });
    const payloadChunk =
      sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
        ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
        : sanitizedChunk;
    publishLiveEvent({
      companyId: currentRun!.companyId,
      type: "heartbeat.run.log",
      payload: {
        runId: currentRun!.id,
        agentId: currentRun!.agentId,
        ts,
        stream,
        chunk: payloadChunk,
        truncated: payloadChunk.length !== sanitizedChunk.length,
      },
    });
  };

  for (const warning of runtimeWorkspaceWarnings) {
    await onLog("stderr", `[hive] ${warning}\n`);
  }

  const adapterEnv = Object.fromEntries(
    Object.entries(parseObject(resolvedConfig.env)).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
  const runtimeServices = await ensureRuntimeServicesForRun({
    db,
    runId: currentRun.id,
    agent: { id: agent.id, name: agent.name, companyId: agent.companyId },
    issue: issueRef,
    workspace: executionWorkspace,
    config: resolvedConfig,
    adapterEnv,
    onLog,
  });
  if (runtimeServices.length > 0) {
    context.hiveRuntimeServices = runtimeServices;
    context.hiveRuntimePrimaryUrl =
      runtimeServices.find((s) => readNonEmptyString(s.url))?.url ?? null;
    await setRunStatus(runId, "running", { contextSnapshot: context });
  }
  if (issueId && (executionWorkspace.created || runtimeServices.some((s) => !s.reused))) {
    try {
      await issuesSvc.addComment(
        issueId,
        buildWorkspaceReadyComment({ workspace: executionWorkspace, runtimeServices }),
        { agentId: agent.id },
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[hive] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  currentRun = await getRun(runId);
  if (!currentRun) return null;

  const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
    if (meta.env && secretKeys.size > 0) {
      for (const key of secretKeys) {
        if (key in meta.env) meta.env[key] = "***REDACTED***";
      }
    }
    await appendRunEvent(currentRun!, seq++, {
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: meta as unknown as Record<string, unknown>,
    });
  };

  const adapter = getServerAdapter(agent.adapterType);
  const authToken = adapter.supportsLocalAgentJwt
    ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, currentRun.id)
    : null;
  if (adapter.supportsLocalAgentJwt && !authToken) {
    logger.warn(
      { companyId: agent.companyId, agentId: agent.id, runId: currentRun.id, adapterType: agent.adapterType },
      "local agent jwt secret missing or invalid; running without injected HIVE_API_KEY",
    );
  }
  const workerAdapterKey = readNonEmptyString(resolvedConfig?.adapterKey) ?? undefined;
  if (
    workerAdapterKey &&
    !readNonEmptyString(context.prompt as string) &&
    !readNonEmptyString(context.instruction as string)
  ) {
    context.prompt =
      issueRef?.title != null && String(issueRef.title).trim()
        ? `Work on issue: ${String(issueRef.title).trim()}`
        : taskKey
          ? `Work on task: ${taskKey}`
          : "Work on the assigned task.";
  }

  const policiesBlock = await formatProductionPoliciesForRun(
    db,
    agent.companyId,
    executionProjectId,
    executionDepartmentId,
  );
  if (policiesBlock) {
    const taskPart =
      readNonEmptyString(context.instruction as string) ??
      readNonEmptyString(context.prompt as string) ??
      "";
    const merged = taskPart.trim()
      ? `${policiesBlock}\n\n---\n\n${taskPart.trim()}`
      : policiesBlock;
    context.instruction = merged;
    context.prompt = merged;
  }

  const adapterResult = await adapter.execute({
    runId: currentRun.id,
    agent,
    runtime: runtimeForAdapter,
    config: resolvedConfig,
    context,
    onLog,
    onMeta: onAdapterMeta,
    authToken: authToken ?? undefined,
    adapterKey: workerAdapterKey,
  });

  if (adapterResult.requeueRun === true) {
    const logSummary = await finalizeAndRemoveRunLogHandle(runId);
    await releaseRuntimeServicesForRun(currentRun.id);
    const nextSessionState = resolveNextSessionState({
      codec: sessionCodec,
      adapterResult,
      previousParams: previousSessionParams,
      previousDisplayId: runtimeForAdapter.sessionDisplayId,
      previousLegacySessionId: runtimeForAdapter.sessionId,
    });
    return {
      adapterResult,
      nextSessionState,
      stdoutExcerpt,
      stderrExcerpt,
      logSummary,
      completionDeferred: false,
      requeueRun: true,
      taskKey,
      previousSessionParams,
      previousSessionDisplayId: runtimeForAdapter.sessionDisplayId,
      runtimeForAdapter,
    };
  }

  const adapterManagedRuntimeServices = adapterResult.runtimeServices
    ? await persistAdapterManagedRuntimeServices({
        db,
        adapterType: agent.adapterType,
        runId: currentRun.id,
        agent: { id: agent.id, name: agent.name, companyId: agent.companyId },
        issue: issueRef,
        workspace: executionWorkspace,
        reports: adapterResult.runtimeServices,
      })
    : [];
  if (adapterManagedRuntimeServices.length > 0) {
    const combinedRuntimeServices = [...runtimeServices, ...adapterManagedRuntimeServices];
    context.hiveRuntimeServices = combinedRuntimeServices;
    context.hiveRuntimePrimaryUrl =
      combinedRuntimeServices.find((s) => readNonEmptyString(s.url))?.url ?? null;
    await setRunStatus(runId, "running", { contextSnapshot: context });
    if (issueId) {
      try {
        await issuesSvc.addComment(
          issueId,
          buildWorkspaceReadyComment({
            workspace: executionWorkspace,
            runtimeServices: adapterManagedRuntimeServices,
          }),
          { agentId: agent.id },
        );
      } catch (err) {
        await onLog(
          "stderr",
          `[hive] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  const nextSessionState = resolveNextSessionState({
    codec: sessionCodec,
    adapterResult,
    previousParams: previousSessionParams,
    previousDisplayId: runtimeForAdapter.sessionDisplayId,
    previousLegacySessionId: runtimeForAdapter.sessionId,
  });

  if (adapterResult.completionDeferred === true) {
    return {
      adapterResult,
      nextSessionState,
      stdoutExcerpt,
      stderrExcerpt,
      logSummary: null,
      completionDeferred: true,
      taskKey,
      previousSessionParams,
      previousSessionDisplayId: runtimeForAdapter.sessionDisplayId,
      runtimeForAdapter,
    };
  }

  let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
  if (handle) {
    logSummary = await runLogStore.finalize(handle);
  }

  await releaseRuntimeServicesForRun(currentRun.id);

  return {
    adapterResult,
    nextSessionState,
    stdoutExcerpt,
    stderrExcerpt,
    logSummary,
    taskKey,
    previousSessionParams,
    previousSessionDisplayId: runtimeForAdapter.sessionDisplayId,
    runtimeForAdapter,
  };
}
