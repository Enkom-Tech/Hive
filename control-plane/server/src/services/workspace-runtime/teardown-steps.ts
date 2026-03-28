import { runGit, runWorkspaceCommand } from "./git-shell.js";
import type { GitWorktreeTeardownStepsInput } from "./types.js";

export const DEFAULT_TEARDOWN_TIMEOUT_MS = 300_000;

export async function runGitWorktreeTeardownSteps(
  input: GitWorktreeTeardownStepsInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const teardownCommand = (input.teardownCommand ?? "").trim();
    if (teardownCommand) {
      await runWorkspaceCommand({
        command: teardownCommand,
        cwd: input.worktreePath,
        timeoutMs: input.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
        env: input.env,
        label:
          input.teardownCommandLabel ??
          `Execution workspace teardown command "${teardownCommand}"`,
      });
    }
    await runGit(["worktree", "remove", "--force", input.worktreePath], input.repoRoot);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
