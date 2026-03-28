import path from "node:path";
import type { Db } from "@hive/db";
import { agents, issues, projectWorkspaces, projects } from "@hive/db";
import { and, asc, eq } from "drizzle-orm";
import { asString, parseObject } from "../../adapters/utils.js";
import { resolveHomeAwarePath } from "../../home-paths.js";
import { activityService } from "../activity.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { parseIssueAssigneeAdapterOverrides } from "../heartbeat/types.js";
import { buildWorkspaceCommandEnv, directoryExists, runGit } from "./git-shell.js";
import { ensurePathUnderRoot, resolveConfiguredPath, sanitizeBranchName } from "./path-utils.js";
import { renderWorkspaceTemplate } from "./templates.js";
import { DEFAULT_TEARDOWN_TIMEOUT_MS, runGitWorktreeTeardownSteps } from "./teardown-steps.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceInput,
  ExecutionWorkspaceIssueRef,
} from "./types.js";

/** Whether teardown should run for the issue's current status and project cleanup policy mode. */
export function executionWorkspaceCleanupShouldRun(cleanupMode: string, issueStatus: string): boolean {
  const mode = cleanupMode.trim() || "manual";
  if (mode === "manual") return false;
  if (mode === "on_done") {
    return issueStatus === "done" || issueStatus === "cancelled";
  }
  if (mode === "on_merged") {
    return issueStatus === "done";
  }
  return false;
}

/**
 * When project `execution_workspace_policy.cleanupPolicy.mode` is `on_done` or `on_merged`, run
 * teardownCommand (if any) and `git worktree remove` for the issue's derived git worktree.
 * `on_done` runs for **done** and **cancelled**; `on_merged` runs for **done** only (cancelled leaves worktree).
 * Idempotent if worktree is already gone.
 */
export async function teardownIssueExecutionWorkspaceOnTerminal(db: Db, issueId: string): Promise<void> {
  const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0] ?? null);
  if (!issueRow?.projectId) return;

  const [projectRow] = await db.select().from(projects).where(eq(projects.id, issueRow.projectId)).limit(1);
  if (!projectRow) return;

  const projectPolicy = parseProjectExecutionWorkspacePolicy(projectRow.executionWorkspacePolicy);
  const cleanupRaw = projectPolicy?.cleanupPolicy ? parseObject(projectPolicy.cleanupPolicy) : {};
  const cleanupMode = asString(cleanupRaw.mode, "manual");
  if (!executionWorkspaceCleanupShouldRun(cleanupMode, issueRow.status)) return;

  const issueSettings =
    parseIssueExecutionWorkspaceSettings(issueRow.executionWorkspaceSettings) ??
    defaultIssueExecutionWorkspaceSettingsForProject(projectPolicy);
  const assigneeOv = issueRow.assigneeAgentId
    ? parseIssueAssigneeAdapterOverrides(issueRow.assigneeAdapterOverrides)
    : null;
  const mode = resolveExecutionWorkspaceMode({
    projectPolicy,
    issueSettings,
    legacyUseProjectWorkspace: assigneeOv?.useProjectWorkspace ?? null,
  });
  if (mode !== "isolated") return;

  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(
      and(eq(projectWorkspaces.companyId, issueRow.companyId), eq(projectWorkspaces.projectId, issueRow.projectId)),
    )
    .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const primary = workspaceRows.find((w) => {
    const c = asString(w.cwd, "").trim();
    return c && c !== "";
  });
  if (!primary?.cwd) return;

  const baseCwd = resolveHomeAwarePath(primary.cwd);
  const agentId = issueRow.assigneeAgentId;
  if (!agentId) return;

  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agentRow) return;

  const baseAgentCfg = parseObject(agentRow.adapterConfig as Record<string, unknown>);
  const agentCfg =
    assigneeOv?.adapterConfig && Object.keys(assigneeOv.adapterConfig).length > 0
      ? { ...baseAgentCfg, ...assigneeOv.adapterConfig }
      : baseAgentCfg;

  const merged = buildExecutionWorkspaceAdapterConfig({
    agentConfig: agentCfg,
    projectPolicy,
    issueSettings,
    mode,
    legacyUseProjectWorkspace: assigneeOv?.useProjectWorkspace ?? null,
  });
  const wsStrat = parseObject(merged.workspaceStrategy as Record<string, unknown>);
  if (asString(wsStrat.type, "") !== "git_worktree") return;

  const issueRef: ExecutionWorkspaceIssueRef = {
    id: issueRow.id,
    identifier: issueRow.identifier,
    title: issueRow.title,
  };
  const agentRef: ExecutionWorkspaceAgentRef = {
    id: agentRow.id,
    name: agentRow.name,
    companyId: agentRow.companyId,
  };
  const base: ExecutionWorkspaceInput = {
    baseCwd,
    source: "project_primary",
    projectId: issueRow.projectId,
    workspaceId: primary.id,
    repoUrl: primary.repoUrl,
    repoRef: primary.repoRef,
  };

  let repoRoot: string;
  try {
    repoRoot = await runGit(["rev-parse", "--show-toplevel"], baseCwd);
  } catch {
    return;
  }

  const branchTemplate = asString(wsStrat.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: issueRef,
    agent: agentRef,
    projectId: base.projectId,
    repoRef: base.repoRef,
  });
  const branchName = sanitizeBranchName(renderedBranch);
  const configuredParentDir = asString(wsStrat.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".hive", "worktrees");
  try {
    ensurePathUnderRoot(worktreeParentDir, repoRoot, "Worktree parent dir");
  } catch {
    return;
  }
  const worktreePath = path.join(worktreeParentDir, branchName);
  const exists = await directoryExists(worktreePath);
  const act = activityService(db);

  if (!exists) {
    await act.create({
      companyId: issueRow.companyId,
      actorType: "system",
      actorId: "hive-workspace",
      action: "execution_workspace.teardown_skip",
      entityType: "issue",
      entityId: issueId,
      agentId: agentRow.id,
      details: { reason: "worktree_missing", worktreePath },
    });
    return;
  }

  const teardownCommand = asString(wsStrat.teardownCommand, "").trim();
  const steps = await runGitWorktreeTeardownSteps({
    repoRoot,
    worktreePath,
    teardownCommand: teardownCommand || undefined,
    teardownTimeoutMs: DEFAULT_TEARDOWN_TIMEOUT_MS,
    env: buildWorkspaceCommandEnv({
      base,
      repoRoot,
      worktreePath,
      branchName,
      issue: issueRef,
      agent: agentRef,
      created: false,
    }),
  });
  const teardownErr = steps.ok ? null : steps.error;

  if (teardownErr) {
    await act.create({
      companyId: issueRow.companyId,
      actorType: "system",
      actorId: "hive-workspace",
      action: "execution_workspace.teardown_failed",
      entityType: "issue",
      entityId: issueId,
      agentId: agentRow.id,
      details: { error: teardownErr, worktreePath },
    });
    return;
  }

  await act.create({
    companyId: issueRow.companyId,
    actorType: "system",
    actorId: "hive-workspace",
    action: "execution_workspace.teardown_complete",
    entityType: "issue",
    entityId: issueId,
    agentId: agentRow.id,
    details: { worktreePath },
  });
}

/**
 * When a VCS merge webhook reports `mergedBranch`, tear down the git worktree for issues that recorded
 * that branch and use cleanupPolicy.mode `on_merged` (does not require issue status `done`).
 */
export async function teardownIssueExecutionWorkspaceOnVcsMerge(
  db: Db,
  issueId: string,
  mergedBranch: string,
): Promise<void> {
  const branch = mergedBranch.trim();
  if (!branch) return;

  const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0] ?? null);
  if (!issueRow?.projectId) return;

  const stored = asString(issueRow.executionWorkspaceBranch, "").trim();
  if (!stored || stored !== branch) return;

  const [projectRow] = await db.select().from(projects).where(eq(projects.id, issueRow.projectId)).limit(1);
  if (!projectRow) return;

  const projectPolicy = parseProjectExecutionWorkspacePolicy(projectRow.executionWorkspacePolicy);
  const cleanupRaw = projectPolicy?.cleanupPolicy ? parseObject(projectPolicy.cleanupPolicy) : {};
  const cleanupMode = asString(cleanupRaw.mode, "manual");
  if (cleanupMode !== "on_merged") return;

  const issueSettings =
    parseIssueExecutionWorkspaceSettings(issueRow.executionWorkspaceSettings) ??
    defaultIssueExecutionWorkspaceSettingsForProject(projectPolicy);
  const assigneeOv = issueRow.assigneeAgentId
    ? parseIssueAssigneeAdapterOverrides(issueRow.assigneeAdapterOverrides)
    : null;
  const mode = resolveExecutionWorkspaceMode({
    projectPolicy,
    issueSettings,
    legacyUseProjectWorkspace: assigneeOv?.useProjectWorkspace ?? null,
  });
  if (mode !== "isolated") return;

  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(
      and(eq(projectWorkspaces.companyId, issueRow.companyId), eq(projectWorkspaces.projectId, issueRow.projectId)),
    )
    .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const primary = workspaceRows.find((w) => {
    const c = asString(w.cwd, "").trim();
    return c && c !== "";
  });
  if (!primary?.cwd) return;

  const baseCwd = resolveHomeAwarePath(primary.cwd);
  const agentId = issueRow.assigneeAgentId;
  if (!agentId) return;

  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agentRow) return;

  const baseAgentCfg = parseObject(agentRow.adapterConfig as Record<string, unknown>);
  const agentCfg =
    assigneeOv?.adapterConfig && Object.keys(assigneeOv.adapterConfig).length > 0
      ? { ...baseAgentCfg, ...assigneeOv.adapterConfig }
      : baseAgentCfg;

  const merged = buildExecutionWorkspaceAdapterConfig({
    agentConfig: agentCfg,
    projectPolicy,
    issueSettings,
    mode,
    legacyUseProjectWorkspace: assigneeOv?.useProjectWorkspace ?? null,
  });
  const wsStrat = parseObject(merged.workspaceStrategy as Record<string, unknown>);
  if (asString(wsStrat.type, "") !== "git_worktree") return;

  const issueRef: ExecutionWorkspaceIssueRef = {
    id: issueRow.id,
    identifier: issueRow.identifier,
    title: issueRow.title,
  };
  const agentRef: ExecutionWorkspaceAgentRef = {
    id: agentRow.id,
    name: agentRow.name,
    companyId: agentRow.companyId,
  };
  const base: ExecutionWorkspaceInput = {
    baseCwd,
    source: "project_primary",
    projectId: issueRow.projectId,
    workspaceId: primary.id,
    repoUrl: primary.repoUrl,
    repoRef: primary.repoRef,
  };

  let repoRoot: string;
  try {
    repoRoot = await runGit(["rev-parse", "--show-toplevel"], baseCwd);
  } catch {
    return;
  }

  const branchTemplate = asString(wsStrat.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: issueRef,
    agent: agentRef,
    projectId: base.projectId,
    repoRef: base.repoRef,
  });
  const branchName = sanitizeBranchName(renderedBranch);
  if (branchName !== branch) return;

  const configuredParentDir = asString(wsStrat.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".hive", "worktrees");
  try {
    ensurePathUnderRoot(worktreeParentDir, repoRoot, "Worktree parent dir");
  } catch {
    return;
  }
  const worktreePath = path.join(worktreeParentDir, branchName);
  const exists = await directoryExists(worktreePath);
  const act = activityService(db);

  if (!exists) {
    await act.create({
      companyId: issueRow.companyId,
      actorType: "system",
      actorId: "hive-workspace",
      action: "execution_workspace.teardown_skip",
      entityType: "issue",
      entityId: issueId,
      agentId: agentRow.id,
      details: { reason: "worktree_missing", worktreePath, trigger: "vcs_merge" },
    });
    return;
  }

  const teardownCommand = asString(wsStrat.teardownCommand, "").trim();
  const steps = await runGitWorktreeTeardownSteps({
    repoRoot,
    worktreePath,
    teardownCommand: teardownCommand || undefined,
    teardownTimeoutMs: DEFAULT_TEARDOWN_TIMEOUT_MS,
    env: buildWorkspaceCommandEnv({
      base,
      repoRoot,
      worktreePath,
      branchName,
      issue: issueRef,
      agent: agentRef,
      created: false,
    }),
  });
  const teardownErr = steps.ok ? null : steps.error;

  if (teardownErr) {
    await act.create({
      companyId: issueRow.companyId,
      actorType: "system",
      actorId: "hive-workspace",
      action: "execution_workspace.teardown_failed",
      entityType: "issue",
      entityId: issueId,
      agentId: agentRow.id,
      details: { error: teardownErr, worktreePath, trigger: "vcs_merge" },
    });
    return;
  }

  await act.create({
    companyId: issueRow.companyId,
    actorType: "system",
    actorId: "hive-workspace",
    action: "execution_workspace.teardown_complete",
    entityType: "issue",
    entityId: issueId,
    agentId: agentRow.id,
    details: { worktreePath, trigger: "vcs_merge" },
  });
}
