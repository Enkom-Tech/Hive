import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { ExecutionWorkspaceAgentRef, ExecutionWorkspaceInput, ExecutionWorkspaceIssueRef } from "./types.js";

export async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

export async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

export function getShellAndArgs(command: string): { shell: string; args: string[] } {
  const isWin = process.platform === "win32";
  const shell = process.env.SHELL?.trim() || (isWin ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");
  const args = isWin ? ["/c", command] : ["-c", command];
  return { shell, args };
}

export function buildWorkspaceCommandEnv(input: {
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HIVE_WORKSPACE_CWD = input.worktreePath;
  env.HIVE_WORKSPACE_PATH = input.worktreePath;
  env.HIVE_WORKSPACE_WORKTREE_PATH = input.worktreePath;
  env.HIVE_WORKSPACE_BRANCH = input.branchName;
  env.HIVE_WORKSPACE_BASE_CWD = input.base.baseCwd;
  env.HIVE_WORKSPACE_REPO_ROOT = input.repoRoot;
  env.HIVE_WORKSPACE_SOURCE = input.base.source;
  env.HIVE_WORKSPACE_REPO_REF = input.base.repoRef ?? "";
  env.HIVE_WORKSPACE_REPO_URL = input.base.repoUrl ?? "";
  env.HIVE_WORKSPACE_CREATED = input.created ? "true" : "false";
  env.HIVE_PROJECT_ID = input.base.projectId ?? "";
  env.HIVE_PROJECT_WORKSPACE_ID = input.base.workspaceId ?? "";
  env.HIVE_AGENT_ID = input.agent.id;
  env.HIVE_AGENT_NAME = input.agent.name;
  env.HIVE_COMPANY_ID = input.agent.companyId;
  env.HIVE_ISSUE_ID = input.issue?.id ?? "";
  env.HIVE_ISSUE_IDENTIFIER = input.issue?.identifier ?? "";
  env.HIVE_ISSUE_TITLE = input.issue?.title ?? "";
  return env;
}

export const DEFAULT_PROVISION_TIMEOUT_MS = 300_000; // 5 minutes

export async function runWorkspaceCommand(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  timeoutMs?: number;
}) {
  const { shell, args } = getShellAndArgs(input.command);
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
  const child = spawn(shell, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const proc = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${input.label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
  if (proc.code === 0) return;

  const details = [proc.stderr.trim(), proc.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${proc.code ?? -1}`,
  );
}
