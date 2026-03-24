import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildExecutionWorkspaceAdapterConfig } from "../services/execution-workspace-policy.js";
import {
  buildWorkspaceReadyComment,
  realizeExecutionWorkspace,
} from "../services/workspace-runtime.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-heartbeat-worktree-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "hive@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Hive Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return repoRoot;
}

describe("heartbeat execution workspace integration", () => {
  it.skipIf(process.platform === "win32")(
    "realizeExecutionWorkspace with heartbeat-style config creates worktree and returns hiveWorkspace shape",
    async () => {
      const repoRoot = await createTempRepo();
      const projectPolicy = {
        enabled: true,
        defaultMode: "isolated" as const,
        workspaceStrategy: {
          type: "git_worktree" as const,
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      };
      const config = buildExecutionWorkspaceAdapterConfig({
        agentConfig: {},
        projectPolicy,
        issueSettings: { mode: "isolated" },
        mode: "isolated",
        legacyUseProjectWorkspace: null,
      });
      const issueRef = { id: "issue-1", identifier: "HB-1", title: "Heartbeat worktree test" };
      const agentRef = { id: "agent-1", name: "Test Agent", companyId: "company-1" };

      const workspace = await realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config,
        issue: issueRef,
        agent: agentRef,
      });

      expect(workspace.strategy).toBe("git_worktree");
      expect(workspace.created).toBe(true);
      expect(workspace.cwd).toContain(path.join(".hive", "worktrees"));
      expect(workspace.cwd).toContain(repoRoot);
      expect(workspace.branchName).toBe("hb-1-heartbeat-worktree-test");
      expect(workspace.worktreePath).toBe(workspace.cwd);

      const hiveWorkspaceShape = {
        cwd: workspace.cwd,
        source: workspace.source,
        strategy: workspace.strategy,
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        repoUrl: workspace.repoUrl,
        repoRef: workspace.repoRef,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
      };
      expect(hiveWorkspaceShape).toMatchObject({
        source: "project_primary",
        strategy: "git_worktree",
        projectId: "project-1",
        branchName: "hb-1-heartbeat-worktree-test",
      });

      const commentBody = buildWorkspaceReadyComment({ workspace, runtimeServices: [] });
      expect(commentBody).toContain(workspace.branchName!);
      expect(commentBody).toContain(workspace.worktreePath!);
    },
  );

  it.skipIf(process.platform === "win32")(
    "second call reuses same worktree for same issue and produces workspace-ready comment",
    async () => {
      const repoRoot = await createTempRepo();
      const config = buildExecutionWorkspaceAdapterConfig({
        agentConfig: {},
        projectPolicy: {
          enabled: true,
          defaultMode: "isolated",
          workspaceStrategy: { type: "git_worktree" },
        },
        issueSettings: { mode: "isolated" },
        mode: "isolated",
        legacyUseProjectWorkspace: null,
      });
      const issueRef = { id: "issue-2", identifier: "HB-2", title: "Reuse test" };
      const agentRef = { id: "agent-1", name: "Agent", companyId: "c1" };
      const base = {
        baseCwd: repoRoot,
        source: "project_primary" as const,
        projectId: "p1",
        workspaceId: "w1",
        repoUrl: null,
        repoRef: "HEAD",
      };

      const first = await realizeExecutionWorkspace({
        base,
        config,
        issue: issueRef,
        agent: agentRef,
      });
      expect(first.created).toBe(true);

      const second = await realizeExecutionWorkspace({
        base,
        config,
        issue: issueRef,
        agent: agentRef,
      });
      expect(second.created).toBe(false);
      expect(second.cwd).toBe(first.cwd);
      expect(second.branchName).toBe(first.branchName);

      const commentBody = buildWorkspaceReadyComment({
        workspace: second,
        runtimeServices: [],
      });
      expect(commentBody).toContain(second.worktreePath!);
    },
  );
});
