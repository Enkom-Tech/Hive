import fs from "node:fs/promises";
import path from "node:path";
import { asString, parseObject } from "../../adapters/utils.js";
import {
  directoryExists,
  runGit,
} from "./git-shell.js";
import { ensurePathUnderRoot, resolveConfiguredPath, sanitizeBranchName } from "./path-utils.js";
import { provisionExecutionWorktree } from "./provision.js";
import { renderWorkspaceTemplate } from "./templates.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceInput,
  ExecutionWorkspaceIssueRef,
  RealizedExecutionWorkspace,
} from "./types.js";

export async function realizeExecutionWorkspace(input: {
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
}): Promise<RealizedExecutionWorkspace> {
  const rawStrategy = parseObject(input.config.workspaceStrategy);
  const strategyType = asString(rawStrategy.type, "project_primary");
  if (strategyType !== "git_worktree") {
    return {
      ...input.base,
      strategy: "project_primary",
      cwd: input.base.baseCwd,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
    };
  }

  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], input.base.baseCwd);
  const branchTemplate = asString(rawStrategy.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: input.issue,
    agent: input.agent,
    projectId: input.base.projectId,
    repoRef: input.base.repoRef,
  });
  const branchName = sanitizeBranchName(renderedBranch);
  const configuredParentDir = asString(rawStrategy.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".hive", "worktrees");
  ensurePathUnderRoot(worktreeParentDir, repoRoot, "Worktree parent dir");
  const worktreePath = path.join(worktreeParentDir, branchName);
  const baseRef = asString(rawStrategy.baseRef, input.base.repoRef ?? "HEAD");

  await fs.mkdir(worktreeParentDir, { recursive: true });

  const existingWorktree = await directoryExists(worktreePath);
  if (existingWorktree) {
    const existingGitDir = await runGit(["rev-parse", "--git-dir"], worktreePath).catch(() => null);
    if (existingGitDir) {
      await provisionExecutionWorktree({
        strategy: rawStrategy,
        base: input.base,
        repoRoot,
        worktreePath,
        branchName,
        issue: input.issue,
        agent: input.agent,
        created: false,
      });
      return {
        ...input.base,
        strategy: "git_worktree",
        cwd: worktreePath,
        branchName,
        worktreePath,
        warnings: [],
        created: false,
      };
    }
    throw new Error(`Configured worktree path "${worktreePath}" already exists and is not a git worktree.`);
  }

  await runGit(["worktree", "add", "-B", branchName, worktreePath, baseRef], repoRoot);
  await provisionExecutionWorktree({
    strategy: rawStrategy,
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created: true,
  });

  return {
    ...input.base,
    strategy: "git_worktree",
    cwd: worktreePath,
    branchName,
    worktreePath,
    warnings: [],
    created: true,
  };
}
