import { and, eq } from "drizzle-orm";
import { issues, projects } from "@hive/db";
import type { AdapterSessionCodec } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { realizeExecutionWorkspace } from "../workspace-runtime.js";
import { resolveWorkspaceForRun } from "./adapter-execution-prelude.js";
import type { AdapterExecutionDeps, ExecuteRunInvocationResult } from "./adapter-execution-types.js";
import {
  deriveTaskKey,
  normalizeSessionParams,
  parseIssueAssigneeAdapterOverrides,
  readNonEmptyString,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  describeSessionResetReason,
  truncateDisplayId,
} from "./types.js";

export type AdapterInvocationPrepareResult = {
  context: Record<string, unknown>;
  taskKey: string | null;
  sessionCodec: AdapterSessionCodec;
  issueId: string | null;
  issueRef: { id: string; identifier: string | null; title: string | null } | null;
  executionProjectId: string | null;
  executionDepartmentId: string | null;
  executionWorkspace: Awaited<ReturnType<typeof realizeExecutionWorkspace>>;
  resolvedConfig: Record<string, unknown>;
  secretKeys: Set<string>;
  runtimeForAdapter: ExecuteRunInvocationResult["runtimeForAdapter"];
  previousSessionParams: Record<string, unknown> | null;
  previousSessionDisplayId: string | null;
  runtimeWorkspaceWarnings: string[];
};

export async function prepareAdapterInvocationPhase(
  deps: AdapterExecutionDeps,
  run: NonNullable<Awaited<ReturnType<AdapterExecutionDeps["getRun"]>>>,
  agent: NonNullable<Awaited<ReturnType<AdapterExecutionDeps["getAgent"]>>>,
): Promise<AdapterInvocationPrepareResult> {
  const { db, getTaskSession, getSessionCodec, secretService: secretsSvc, ensureRuntimeState } = deps;

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
  if (issueId && executionWorkspace.branchName) {
    await db
      .update(issues)
      .set({ executionWorkspaceBranch: executionWorkspace.branchName, updatedAt: new Date() })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
  }
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

  const runtime = (await ensureRuntimeState(agent)) as { sessionId: string | null } | null;
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

  return {
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
    previousSessionDisplayId,
    runtimeWorkspaceWarnings,
  };
}
