import { asString, parseObject } from "../../adapters/utils.js";
import { buildWorkspaceCommandEnv, DEFAULT_PROVISION_TIMEOUT_MS, runWorkspaceCommand } from "./git-shell.js";
import type { ExecutionWorkspaceAgentRef, ExecutionWorkspaceInput, ExecutionWorkspaceIssueRef } from "./types.js";

/** Provision/teardown commands are trusted (project- or operator-configured), not user-supplied at runtime. */
export async function provisionExecutionWorktree(input: {
  strategy: Record<string, unknown>;
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
  if (!provisionCommand) return;

  await runWorkspaceCommand({
    command: provisionCommand,
    cwd: input.worktreePath,
    timeoutMs: DEFAULT_PROVISION_TIMEOUT_MS,
    env: buildWorkspaceCommandEnv({
      base: input.base,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      issue: input.issue,
      agent: input.agent,
      created: input.created,
    }),
    label: `Execution workspace provision command "${provisionCommand}"`,
  });
}
