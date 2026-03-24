import fs from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, heartbeatRuns, issues, projectWorkspaces, projects } from "@hive/db";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec } from "../../adapters/index.js";
import { getServerAdapter } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { logger } from "../../middleware/logger.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import type { RunLogHandle } from "../run-log-store.js";
import { issueService } from "../issues.js";
import { secretService } from "../secrets.js";
import {
  buildWorkspaceReadyComment,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
} from "../workspace-runtime.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import {
  appendExcerpt,
  deriveTaskKey,
  MAX_LIVE_LOG_CHUNK_BYTES,
  normalizeSessionParams,
  parseIssueAssigneeAdapterOverrides,
  readNonEmptyString,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  describeSessionResetReason,
  truncateDisplayId,
  type ResolvedWorkspaceForRun,
} from "./types.js";
import {
  hiveInstanceRelativePathIfUnderRoot,
  resolveDefaultAgentWorkspaceDir,
} from "../../home-paths.js";
import { REPO_ONLY_CWD_SENTINEL } from "./types.js";
import { formatProductionPoliciesForRun } from "../production-policies-for-run.js";

function pathForWorkspaceWarning(absolutePath: string): string {
  return hiveInstanceRelativePathIfUnderRoot(absolutePath) ?? absolutePath;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

export function getDefaultSessionCodec(): AdapterSessionCodec {
  return defaultSessionCodec;
}

export function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams = hasExplicitParams
    ? explicitParams
    : hasExplicitSessionId
      ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
      : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export async function resolveWorkspaceForRun(
  db: Db,
  agent: typeof agents.$inferSelect,
  context: Record<string, unknown>,
  previousSessionParams: Record<string, unknown> | null,
  opts?: { useProjectWorkspace?: boolean | null },
): Promise<ResolvedWorkspaceForRun> {
  const issueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);
  const issueProjectId = issueId
    ? await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null)
    : null;
  const resolvedProjectId = issueProjectId ?? contextProjectId;
  const useProjectWorkspace = opts?.useProjectWorkspace !== false;
  const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

  const projectWorkspaceRows = workspaceProjectId
    ? await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, agent.companyId),
            eq(projectWorkspaces.projectId, workspaceProjectId),
          ),
        )
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
    : [];

  const workspaceHints = projectWorkspaceRows.map((workspace) => ({
    workspaceId: workspace.id,
    cwd: readNonEmptyString(workspace.cwd),
    repoUrl: readNonEmptyString(workspace.repoUrl),
    repoRef: readNonEmptyString(workspace.repoRef),
  }));

  if (projectWorkspaceRows.length > 0) {
    const missingProjectCwds: string[] = [];
    let hasConfiguredProjectCwd = false;
    for (const workspace of projectWorkspaceRows) {
      const projectCwd = readNonEmptyString(workspace.cwd);
      if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) continue;
      hasConfiguredProjectCwd = true;
      const projectCwdExists = await fs
        .stat(projectCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (projectCwdExists) {
        return {
          cwd: projectCwd,
          source: "project_primary",
          projectId: resolvedProjectId,
          workspaceId: workspace.id,
          repoUrl: workspace.repoUrl,
          repoRef: workspace.repoRef,
          workspaceHints,
          warnings: [],
        };
      }
      missingProjectCwds.push(projectCwd);
    }

    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(fallbackCwd, { recursive: true });
    const warnings: string[] = [];
    if (missingProjectCwds.length > 0) {
      const firstMissing = missingProjectCwds[0];
      const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
      const fb = pathForWorkspaceWarning(fallbackCwd);
      const miss = pathForWorkspaceWarning(firstMissing);
      warnings.push(
        extraMissingCount > 0
          ? `Project workspace path "${miss}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fb}" for this run.`
          : `Project workspace path "${miss}" is not available yet. Using fallback workspace "${fb}" for this run.`,
      );
    } else if (!hasConfiguredProjectCwd) {
      warnings.push(
        `Project workspace has no local cwd configured. Using fallback workspace "${pathForWorkspaceWarning(fallbackCwd)}" for this run.`,
      );
    }
    return {
      cwd: fallbackCwd,
      source: "project_primary",
      projectId: resolvedProjectId,
      workspaceId: projectWorkspaceRows[0]?.id ?? null,
      repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
      repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
      workspaceHints,
      warnings,
    };
  }

  const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (sessionCwd) {
    const sessionCwdExists = await fs
      .stat(sessionCwd)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (sessionCwdExists) {
      return {
        cwd: sessionCwd,
        source: "task_session",
        projectId: resolvedProjectId,
        workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
        repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
        repoRef: readNonEmptyString(previousSessionParams?.repoRef),
        workspaceHints,
        warnings: [],
      };
    }
  }

  const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
  await fs.mkdir(cwd, { recursive: true });
  const warnings: string[] = [];
  if (sessionCwd) {
    warnings.push(
      `Saved session workspace "${pathForWorkspaceWarning(sessionCwd)}" is not available. Using fallback workspace "${pathForWorkspaceWarning(cwd)}" for this run.`,
    );
  } else if (resolvedProjectId) {
    warnings.push(
      `No project workspace directory is currently available for this issue. Using fallback workspace "${pathForWorkspaceWarning(cwd)}" for this run.`,
    );
  } else {
    warnings.push(
      `No project or prior session workspace was available. Using fallback workspace "${pathForWorkspaceWarning(cwd)}" for this run.`,
    );
  }
  return {
    cwd,
    source: "agent_home",
    projectId: resolvedProjectId,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    workspaceHints,
    warnings,
  };
}

export interface AdapterExecutionDeps {
  db: Db;
  getRun: (runId: string) => Promise<(typeof heartbeatRuns.$inferSelect) | null>;
  getAgent: (agentId: string) => Promise<(typeof agents.$inferSelect) | null>;
  setRunStatus: (
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) => Promise<(typeof heartbeatRuns.$inferSelect) | null>;
  appendRunEvent: (
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: { eventType: string; stream?: "system" | "stdout" | "stderr"; level?: "info" | "warn" | "error"; message?: string; payload?: Record<string, unknown> },
  ) => Promise<void>;
  registerDeferredRunLogHandle: (runId: string, handle: RunLogHandle) => void;
  finalizeAndRemoveRunLogHandle: (
    runId: string,
  ) => Promise<{ bytes: number; sha256?: string; compressed: boolean } | null>;
  ensureRuntimeState: (agent: typeof agents.$inferSelect) => Promise<unknown>;
  getTaskSession: (
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) => Promise<{ sessionParamsJson: unknown; sessionDisplayId: string | null } | null>;
  runLogStore: {
    begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
    append(handle: RunLogHandle, event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string }): Promise<void>;
    finalize(handle: RunLogHandle): Promise<{ bytes: number; sha256?: string; compressed: boolean }>;
  };
  getSessionCodec: (adapterType: string) => AdapterSessionCodec;
  issueService: ReturnType<typeof issueService>;
  secretService: ReturnType<typeof secretService>;
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
}

export interface ExecuteRunInvocationResult {
  adapterResult: AdapterExecutionResult;
  nextSessionState: { params: Record<string, unknown> | null; displayId: string | null; legacySessionId: string | null };
  stdoutExcerpt: string;
  stderrExcerpt: string;
  logSummary: { bytes: number; sha256?: string; compressed: boolean } | null;
  completionDeferred?: boolean;
  requeueRun?: boolean;
  taskKey: string | null;
  previousSessionParams: Record<string, unknown> | null;
  previousSessionDisplayId: string | null;
  runtimeForAdapter: { sessionId: string | null; sessionParams: Record<string, unknown> | null; sessionDisplayId: string | null; taskKey: string | null };
}

export function createAdapterExecution(deps: AdapterExecutionDeps) {
  const {
    db,
    getRun,
    getAgent,
    setRunStatus,
    appendRunEvent,
    registerDeferredRunLogHandle,
    finalizeAndRemoveRunLogHandle,
    ensureRuntimeState,
    getTaskSession,
    runLogStore,
    getSessionCodec,
    issueService: issuesSvc,
    secretService: secretsSvc,
    publishLiveEvent,
  } = deps;

  async function executeRunInvocation(runId: string): Promise<ExecuteRunInvocationResult | null> {
    let run = await getRun(runId);
    if (!run) return null;
    if (run.status !== "queued" && run.status !== "running") return null;

    const agent = await getAgent(run.agentId);
    if (!agent) return null;

    await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueAssigneeConfig = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            departmentId: issues.departmentId,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueAssigneeConfig && issueAssigneeConfig.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(issueAssigneeConfig.assigneeAdapterOverrides)
        : null;
    const issueExecutionWorkspaceSettings = parseIssueExecutionWorkspaceSettings(
      issueAssigneeConfig?.executionWorkspaceSettings,
    );
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueAssigneeConfig?.projectId ?? contextProjectId;
    const executionDepartmentId = issueAssigneeConfig?.departmentId ?? null;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const config = parseObject(agent.adapterConfig);
    const executionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(db, agent, context, previousSessionParams, {
      useProjectWorkspace: executionWorkspaceMode !== "agent_default",
    });
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : workspaceManagedConfig;
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      mergedConfig,
    );
    const issueRef = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const executionWorkspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      },
      config: resolvedConfig,
      issue: issueRef,
      agent: { id: agent.id, name: agent.name, companyId: agent.companyId },
    });
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: { ...resolvedWorkspace, cwd: executionWorkspace.cwd },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const sessionResetReason = describeSessionResetReason(context);
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.hiveWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: executionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
    };
    context.hiveWorkspaces = resolvedWorkspace.workspaceHints;
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.hiveRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.hiveRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }

    const runtime = await ensureRuntimeState(agent) as { sessionId: string | null } | null;
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime?.sessionId ?? null;
    const previousSessionDisplayId = truncateDisplayId(
      taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    const runtimeForAdapter = {
      sessionId: readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback,
      sessionParams: runtimeSessionParams,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

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

    run = await getRun(runId);
    if (!run) return null;
    await appendRunEvent(run, seq++, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
    });

    handle = await runLogStore.begin({
      companyId: run.companyId,
      agentId: run.agentId,
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
        companyId: run!.companyId,
        type: "heartbeat.run.log",
        payload: {
          runId: run!.id,
          agentId: run!.agentId,
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
      runId: run.id,
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

    const currentRun = await getRun(runId);
    if (!currentRun) return null;

    const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
      if (meta.env && secretKeys.size > 0) {
        for (const key of secretKeys) {
          if (key in meta.env) meta.env[key] = "***REDACTED***";
        }
      }
      await appendRunEvent(currentRun, seq++, {
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: meta as unknown as Record<string, unknown>,
      });
    };

    const adapter = getServerAdapter(agent.adapterType);
    const authToken = adapter.supportsLocalAgentJwt
      ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
      : null;
    if (adapter.supportsLocalAgentJwt && !authToken) {
      logger.warn(
        { companyId: agent.companyId, agentId: agent.id, runId: run.id, adapterType: agent.adapterType },
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
      runId: run.id,
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
      await releaseRuntimeServicesForRun(run.id);
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
          runId: run.id,
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

    await releaseRuntimeServicesForRun(run.id);

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

  return { executeRunInvocation };
}
