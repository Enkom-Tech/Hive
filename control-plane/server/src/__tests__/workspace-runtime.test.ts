import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceRuntimeManager,
  normalizeAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  runGitWorktreeTeardownSteps,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);
const leasedRunIds = new Set<string>();
let runtimeManager: WorkspaceRuntimeManager;

beforeEach(() => {
  runtimeManager = new WorkspaceRuntimeManager();
});

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-worktree-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "hive@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Hive Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return repoRoot;
}

function buildWorkspace(cwd: string): RealizedExecutionWorkspace {
  return {
    baseCwd: cwd,
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: "HEAD",
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

afterEach(async () => {
  await Promise.all(
    Array.from(leasedRunIds).map(async (runId) => {
      await runtimeManager.releaseRuntimeServicesForRun(runId);
      leasedRunIds.delete(runId);
    }),
  );
});

describe("realizeExecutionWorkspace", () => {
  it.skipIf(process.platform === "win32")("creates and reuses a git worktree for an issue-scoped branch", async () => {
    const repoRoot = await createTempRepo();

    const first = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(first.strategy).toBe("git_worktree");
    expect(first.created).toBe(true);
    expect(first.branchName).toBe("PAP-447-add-worktree-support");
    expect(first.cwd).toContain(path.join(".hive", "worktrees"));
    await expect(fs.stat(path.join(first.cwd, ".git"))).resolves.toBeTruthy();

    const second = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branchName).toBe(first.branchName);
  });

  it.skipIf(process.platform === "win32")("runs a configured provision command inside the derived worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    // Use set -eu only (no pipefail) so script runs on minimal/bash-on-Windows
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "printf '%s\\n' \"$HIVE_WORKSPACE_BRANCH\" > .hive-provision-branch",
        "printf '%s\\n' \"$HIVE_WORKSPACE_BASE_CWD\" > .hive-provision-base",
        "printf '%s\\n' \"$HIVE_WORKSPACE_CREATED\" > .hive-provision-created",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(workspace.cwd, ".hive-provision-branch"), "utf8")).resolves.toBe(
      "PAP-448-run-provision-command\n",
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".hive-provision-base"), "utf8")).resolves.toBe(
      `${repoRoot}\n`,
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".hive-provision-created"), "utf8")).resolves.toBe(
      "true\n",
    );

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(reused.cwd, ".hive-provision-created"), "utf8")).resolves.toBe("false\n");
  });

  it.skipIf(process.platform === "win32")("rejects worktreeParentDir that escapes repository root", async () => {
    const repoRoot = await createTempRepo();
    await expect(
      realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "p1",
          workspaceId: "w1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            worktreeParentDir: "../../escaped",
          },
        },
        issue: { id: "i1", identifier: "X-1", title: "Issue" },
        agent: { id: "a1", name: "Agent", companyId: "c1" },
      }),
    ).rejects.toThrow(/resolves outside repository root/);
  });

  it.skipIf(process.platform === "win32")("accepts safe relative worktreeParentDir under repo", async () => {
    const repoRoot = await createTempRepo();
    const result = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "p1",
        workspaceId: "w1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-branch",
          worktreeParentDir: "worktrees",
        },
      },
      issue: { id: "i1", identifier: "Y-2", title: "Safe path" },
      agent: { id: "a1", name: "Agent", companyId: "c1" },
    });
    expect(result.strategy).toBe("git_worktree");
    expect(result.cwd).toContain("worktrees");
    expect(result.cwd).toContain(repoRoot);
  });

  it.skipIf(process.platform === "win32")("fails when provision command exits non-zero and leaves worktree created", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "fail-provision.sh"),
      ["#!/usr/bin/env bash", "set -eu", "echo 'provision failed' >&2", "exit 1"].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/fail-provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add failing provision"]);

    await expect(
      realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "p1",
          workspaceId: "w1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "{{issue.identifier}}-branch",
            provisionCommand: "bash ./scripts/fail-provision.sh",
          },
        },
        issue: { id: "i1", identifier: "Z-3", title: "Failing provision" },
        agent: { id: "a1", name: "Agent", companyId: "c1" },
      }),
    ).rejects.toThrow(/provision command.*failed/);

    const worktreesDir = path.join(repoRoot, ".hive", "worktrees");
    const worktreePath = path.join(worktreesDir, "Z-3-branch");
    await expect(fs.stat(worktreePath)).resolves.toBeTruthy();
  });
});

describe("ensureRuntimeServicesForRun", () => {
  it.skipIf(process.platform === "win32")("reuses shared runtime services across runs and starts a new service after release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-runtime-workspace-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"";

    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const run1 = "run-1";
    const run2 = "run-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await runtimeManager.ensureRuntimeServicesForRun({
      runId: run1,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.reused).toBe(false);
    expect(first[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(first[0]!.url!);
    expect(await response.text()).toBe("ok");

    const second = await runtimeManager.ensureRuntimeServicesForRun({
      runId: run2,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.reused).toBe(true);
    expect(second[0]?.id).toBe(first[0]?.id);

    await runtimeManager.releaseRuntimeServicesForRun(run1);
    leasedRunIds.delete(run1);
    await runtimeManager.releaseRuntimeServicesForRun(run2);
    leasedRunIds.delete(run2);

    const run3 = "run-3";
    leasedRunIds.add(run3);
    const third = await runtimeManager.ensureRuntimeServicesForRun({
      runId: run3,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(third).toHaveLength(1);
    expect(third[0]?.reused).toBe(false);
    expect(third[0]?.id).not.toBe(first[0]?.id);
  });
});

describe("normalizeAdapterManagedRuntimeServices", () => {
  it("fills workspace defaults and derives stable ids for adapter-managed services", () => {
    const workspace = buildWorkspace("/tmp/project");
    const now = new Date("2026-03-09T12:00:00.000Z");

    const first = normalizeAdapterManagedRuntimeServices({
      adapterType: "managed_worker",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    const second = normalizeAdapterManagedRuntimeServices({
      adapterType: "managed_worker",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      issueId: "issue-1",
      serviceName: "preview",
      provider: "adapter_managed",
      status: "running",
      healthStatus: "healthy",
      startedByRunId: "run-1",
    });
    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

describe("runGitWorktreeTeardownSteps", () => {
  it.skipIf(process.platform === "win32")(
    "removes an existing git worktree when no teardown command is set",
    async () => {
      const repoRoot = await createTempRepo();
      const worktreeParent = path.join(repoRoot, ".hive", "worktrees");
      await fs.mkdir(worktreeParent, { recursive: true });
      const worktreePath = path.join(worktreeParent, "teardown-branch");
      await runGit(repoRoot, ["worktree", "add", "-b", "teardown-branch", worktreePath, "HEAD"]);

      const r = await runGitWorktreeTeardownSteps({
        repoRoot,
        worktreePath,
        env: { ...process.env },
      });
      expect(r).toEqual({ ok: true });
      await expect(fs.stat(worktreePath)).rejects.toThrow();
    },
  );
});
