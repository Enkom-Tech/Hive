import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterRuntimeServiceReport } from "@hive/adapter-utils";
import type { Db } from "@hive/db";
import { agents, issues, projectWorkspaces, projects, workspaceRuntimeServices } from "@hive/db";
import { activityService } from "./activity.js";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { parseIssueAssigneeAdapterOverrides } from "./heartbeat/types.js";
import { asNumber, asString, parseObject, renderTemplate } from "../adapters/utils.js";
import { resolveHomeAwarePath } from "../home-paths.js";

export interface ExecutionWorkspaceInput {
  baseCwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
}

export interface ExecutionWorkspaceIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
}

export interface ExecutionWorkspaceAgentRef {
  id: string;
  name: string;
  companyId: string;
}

export interface RealizedExecutionWorkspace extends ExecutionWorkspaceInput {
  strategy: "project_primary" | "git_worktree";
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  warnings: string[];
  created: boolean;
}

export interface RuntimeServiceRef {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  issueId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  reused: boolean;
}

interface RuntimeServiceRecord extends RuntimeServiceRef {
  db?: Db;
  child: ChildProcess | null;
  leaseRunIds: Set<string>;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  envFingerprint: string;
}

export type WorkspaceRuntimeState = {
  runtimeServicesById: Map<string, RuntimeServiceRecord>;
  runtimeServicesByReuseKey: Map<string, string>;
  runtimeServiceLeasesByRun: Map<string, string[]>;
};

function createWorkspaceRuntimeState(): WorkspaceRuntimeState {
  return {
    runtimeServicesById: new Map<string, RuntimeServiceRecord>(),
    runtimeServicesByReuseKey: new Map<string, string>(),
    runtimeServiceLeasesByRun: new Map<string, string[]>(),
  };
}

export class WorkspaceRuntimeManager {
  private state: WorkspaceRuntimeState;

  constructor(input?: Partial<WorkspaceRuntimeState>) {
    this.state = {
      runtimeServicesById: input?.runtimeServicesById ?? new Map<string, RuntimeServiceRecord>(),
      runtimeServicesByReuseKey: input?.runtimeServicesByReuseKey ?? new Map<string, string>(),
      runtimeServiceLeasesByRun: input?.runtimeServiceLeasesByRun ?? new Map<string, string[]>(),
    };
  }

  /** Removes all in-memory runtime service state (useful for unit tests). */
  resetForTests() {
    this.state.runtimeServicesById.clear();
    this.state.runtimeServicesByReuseKey.clear();
    this.state.runtimeServiceLeasesByRun.clear();
  }

  async ensureRuntimeServicesForRun(input: {
    db?: Db;
    runId: string;
    agent: ExecutionWorkspaceAgentRef;
    issue: ExecutionWorkspaceIssueRef | null;
    workspace: RealizedExecutionWorkspace;
    config: Record<string, unknown>;
    adapterEnv: Record<string, string>;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }): Promise<RuntimeServiceRef[]> {
    return ensureRuntimeServicesForRunWithState(this.state, input);
  }

  async releaseRuntimeServicesForRun(runId: string): Promise<void> {
    await releaseRuntimeServicesForRunWithState(this.state, runId);
  }
}

const defaultWorkspaceRuntimeManager = new WorkspaceRuntimeManager();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableRuntimeServiceId(input: {
  adapterType: string;
  runId: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
  serviceName: string;
  reportId: string | null;
  providerRef: string | null;
  reuseKey: string | null;
}) {
  if (input.reportId) return input.reportId;
  const digest = createHash("sha256")
    .update(
      stableStringify({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        serviceName: input.serviceName,
        providerRef: input.providerRef,
        reuseKey: input.reuseKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.adapterType}-${digest}`;
}

function toRuntimeServiceRef(record: RuntimeServiceRecord, overrides?: Partial<RuntimeServiceRef>): RuntimeServiceRef {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    issueId: record.issueId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: record.lastUsedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    reused: record.reused,
    ...overrides,
  };
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function renderWorkspaceTemplate(template: string, input: {
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  projectId: string | null;
  repoRef: string | null;
}) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id,
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "hive-work";
}

function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

/** Throws if candidatePath is not under rootPath (prevents path traversal). */
function ensurePathUnderRoot(candidatePath: string, rootPath: string, label: string): void {
  const rootResolved = path.resolve(rootPath);
  const rootWithSep = rootResolved + path.sep;
  const candidateResolved = path.resolve(candidatePath);
  if (candidateResolved !== rootResolved && !candidateResolved.startsWith(rootWithSep)) {
    throw new Error(`${label} resolves outside repository root (${candidatePath})`);
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
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

async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

function buildWorkspaceCommandEnv(input: {
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

function getShellAndArgs(command: string): { shell: string; args: string[] } {
  const isWin = process.platform === "win32";
  const shell = process.env.SHELL?.trim() || (isWin ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");
  const args = isWin ? ["/c", command] : ["-c", command];
  return { shell, args };
}

const DEFAULT_PROVISION_TIMEOUT_MS = 300_000; // 5 minutes
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 300_000;

export type GitWorktreeTeardownStepsInput = {
  repoRoot: string;
  worktreePath: string;
  /** Optional shell command run with cwd = worktreePath before `git worktree remove`. */
  teardownCommand?: string;
  teardownTimeoutMs?: number;
  env: NodeJS.ProcessEnv;
  /** Overrides default label when teardownCommand is set. */
  teardownCommandLabel?: string;
};

/**
 * Runs optional teardown script in the worktree, then `git worktree remove --force`.
 * Used by issue terminal cleanup and covered by Vitest with a temp repository.
 */
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

async function runWorkspaceCommand(input: {
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

/** Provision/teardown commands are trusted (project- or operator-configured), not user-supplied at runtime. */
async function provisionExecutionWorktree(input: {
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

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function buildTemplateData(input: {
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  port: number | null;
}) {
  return {
    workspace: {
      cwd: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      worktreePath: input.workspace.worktreePath ?? "",
      repoUrl: input.workspace.repoUrl ?? "",
      repoRef: input.workspace.repoRef ?? "",
      env: input.adapterEnv,
    },
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id,
      name: input.agent.name,
    },
    port: input.port ?? "",
  };
}

function resolveServiceScopeId(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  issue: ExecutionWorkspaceIssueRef | null;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
}): {
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
} {
  const scopeTypeRaw = asString(input.service.reuseScope, input.service.lifecycle === "shared" ? "project_workspace" : "run");
  const scopeType =
    scopeTypeRaw === "project_workspace" ||
    scopeTypeRaw === "execution_workspace" ||
    scopeTypeRaw === "agent"
      ? scopeTypeRaw
      : "run";
  if (scopeType === "project_workspace") return { scopeType, scopeId: input.workspace.workspaceId ?? input.workspace.projectId };
  if (scopeType === "execution_workspace") return { scopeType, scopeId: input.workspace.cwd };
  if (scopeType === "agent") return { scopeType, scopeId: input.agent.id };
  return { scopeType: "run" as const, scopeId: input.runId };
}

async function waitForReadiness(input: {
  service: Record<string, unknown>;
  url: string | null;
}) {
  const readiness = parseObject(input.service.readiness);
  const readinessType = asString(readiness.type, "");
  if (readinessType !== "http" || !input.url) return;
  const timeoutSec = Math.max(1, asNumber(readiness.timeoutSec, 30));
  const intervalMs = Math.max(100, asNumber(readiness.intervalMs, 500));
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = "service did not become ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(input.url);
      if (response.ok) return;
      lastError = `received HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  throw new Error(`Readiness check failed for ${input.url}: ${lastError}`);
}

function toPersistedWorkspaceRuntimeService(record: RuntimeServiceRecord): typeof workspaceRuntimeServices.$inferInsert {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    issueId: record.issueId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: new Date(record.lastUsedAt),
    startedAt: new Date(record.startedAt),
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt) : null,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    updatedAt: new Date(),
  };
}

async function persistRuntimeServiceRecord(db: Db | undefined, record: RuntimeServiceRecord) {
  if (!db) return;
  const values = toPersistedWorkspaceRuntimeService(record);
  await db
    .insert(workspaceRuntimeServices)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceRuntimeServices.id,
      set: {
        projectId: values.projectId,
        projectWorkspaceId: values.projectWorkspaceId,
        issueId: values.issueId,
        scopeType: values.scopeType,
        scopeId: values.scopeId,
        serviceName: values.serviceName,
        status: values.status,
        lifecycle: values.lifecycle,
        reuseKey: values.reuseKey,
        command: values.command,
        cwd: values.cwd,
        port: values.port,
        url: values.url,
        provider: values.provider,
        providerRef: values.providerRef,
        ownerAgentId: values.ownerAgentId,
        startedByRunId: values.startedByRunId,
        lastUsedAt: values.lastUsedAt,
        startedAt: values.startedAt,
        stoppedAt: values.stoppedAt,
        stopPolicy: values.stopPolicy,
        healthStatus: values.healthStatus,
        updatedAt: values.updatedAt,
      },
    });
}

function clearIdleTimer(record: RuntimeServiceRecord) {
  if (!record.idleTimer) return;
  clearTimeout(record.idleTimer);
  record.idleTimer = null;
}

export function normalizeAdapterManagedRuntimeServices(input: {
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  reports: AdapterRuntimeServiceReport[];
  now?: Date;
}): RuntimeServiceRef[] {
  const nowIso = (input.now ?? new Date()).toISOString();
  return input.reports.map((report) => {
    const scopeType = report.scopeType ?? "run";
    const scopeId =
      report.scopeId ??
      (scopeType === "project_workspace"
        ? input.workspace.workspaceId
        : scopeType === "execution_workspace"
          ? input.workspace.cwd
          : scopeType === "agent"
            ? input.agent.id
            : input.runId) ??
      null;
    const serviceName = asString(report.serviceName, "").trim() || "service";
    const status = report.status ?? "running";
    const lifecycle = report.lifecycle ?? "ephemeral";
    const healthStatus =
      report.healthStatus ??
      (status === "running" ? "healthy" : status === "failed" ? "unhealthy" : "unknown");
    return {
      id: stableRuntimeServiceId({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType,
        scopeId,
        serviceName,
        reportId: report.id ?? null,
        providerRef: report.providerRef ?? null,
        reuseKey: report.reuseKey ?? null,
      }),
      companyId: input.agent.companyId,
      projectId: report.projectId ?? input.workspace.projectId,
      projectWorkspaceId: report.projectWorkspaceId ?? input.workspace.workspaceId,
      issueId: report.issueId ?? input.issue?.id ?? null,
      serviceName,
      status,
      lifecycle,
      scopeType,
      scopeId,
      reuseKey: report.reuseKey ?? null,
      command: report.command ?? null,
      cwd: report.cwd ?? null,
      port: report.port ?? null,
      url: report.url ?? null,
      provider: "adapter_managed",
      providerRef: report.providerRef ?? null,
      ownerAgentId: report.ownerAgentId ?? input.agent.id,
      startedByRunId: input.runId,
      lastUsedAt: nowIso,
      startedAt: nowIso,
      stoppedAt: status === "running" || status === "starting" ? null : nowIso,
      stopPolicy: report.stopPolicy ?? null,
      healthStatus,
      reused: false,
    };
  });
}

async function startLocalRuntimeService(input: {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  adapterEnv: Record<string, string>;
  service: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  reuseKey: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
}): Promise<RuntimeServiceRecord> {
  const serviceName = asString(input.service.name, "service");
  const lifecycle = asString(input.service.lifecycle, "shared") === "ephemeral" ? "ephemeral" : "shared";
  const command = asString(input.service.command, "");
  if (!command) throw new Error(`Runtime service "${serviceName}" is missing command`);
  const serviceCwdTemplate = asString(input.service.cwd, ".");
  const portConfig = parseObject(input.service.port);
  const port = asString(portConfig.type, "") === "auto" ? await allocatePort() : null;
  const envConfig = parseObject(input.service.env);
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port,
  });
  const serviceCwd = resolveConfiguredPath(renderTemplate(serviceCwdTemplate, templateData), input.workspace.cwd);
  const env: Record<string, string> = { ...process.env, ...input.adapterEnv } as Record<string, string>;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") {
      env[key] = renderTemplate(value, templateData);
    }
  }
  if (port) {
    const portEnvKey = asString(portConfig.envKey, "PORT");
    env[portEnvKey] = String(port);
  }
  const isWin = process.platform === "win32";
  const shell = process.env.SHELL?.trim() || (isWin ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");
  const shellArgs = isWin ? ["/c", command] : ["-lc", command];
  const child = spawn(shell, shellArgs, {
    cwd: serviceCwd,
    env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrExcerpt = "";
  let stdoutExcerpt = "";
  child.stdout?.on("data", async (chunk) => {
    const text = String(chunk);
    stdoutExcerpt = (stdoutExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stdout", `[service:${serviceName}] ${text}`);
  });
  child.stderr?.on("data", async (chunk) => {
    const text = String(chunk);
    stderrExcerpt = (stderrExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stderr", `[service:${serviceName}] ${text}`);
  });

  const expose = parseObject(input.service.expose);
  const readiness = parseObject(input.service.readiness);
  const urlTemplate =
    asString(expose.urlTemplate, "") ||
    asString(readiness.urlTemplate, "");
  const url = urlTemplate ? renderTemplate(urlTemplate, templateData) : null;

  try {
    await waitForReadiness({ service: input.service, url });
  } catch (err) {
    child.kill("SIGTERM");
    throw new Error(
      `Failed to start runtime service "${serviceName}": ${err instanceof Error ? err.message : String(err)}${stderrExcerpt ? ` | stderr: ${stderrExcerpt.trim()}` : ""}`,
    );
  }

  const envFingerprint = createHash("sha256").update(stableStringify(envConfig)).digest("hex");
  return {
    id: randomUUID(),
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    issueId: input.issue?.id ?? null,
    serviceName,
    status: "running",
    lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command,
    cwd: serviceCwd,
    port,
    url,
    provider: "local_process",
    providerRef: child.pid ? String(child.pid) : null,
    ownerAgentId: input.agent.id,
    startedByRunId: input.runId,
    lastUsedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stopPolicy: parseObject(input.service.stopPolicy),
    healthStatus: "healthy",
    reused: false,
    db: input.db,
    child,
    leaseRunIds: new Set([input.runId]),
    idleTimer: null,
    envFingerprint,
  };
}

function scheduleIdleStop(state: WorkspaceRuntimeState, record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const stopType = asString(record.stopPolicy?.type, "manual");
  if (stopType !== "idle_timeout") return;
  const idleSeconds = Math.max(1, asNumber(record.stopPolicy?.idleSeconds, 1800));
  record.idleTimer = setTimeout(() => {
    stopRuntimeService(state, record.id).catch(() => undefined);
  }, idleSeconds * 1000);
}

async function stopRuntimeService(state: WorkspaceRuntimeState, serviceId: string) {
  const record = state.runtimeServicesById.get(serviceId);
  if (!record) return;
  clearIdleTimer(record);
  record.status = "stopped";
  record.lastUsedAt = new Date().toISOString();
  record.stoppedAt = new Date().toISOString();
  if (record.child && !record.child.killed) {
    record.child.kill("SIGTERM");
  }
  state.runtimeServicesById.delete(serviceId);
  if (record.reuseKey) {
    state.runtimeServicesByReuseKey.delete(record.reuseKey);
  }
  await persistRuntimeServiceRecord(record.db, record);
}

function registerRuntimeService(state: WorkspaceRuntimeState, db: Db | undefined, record: RuntimeServiceRecord) {
  record.db = db;
  state.runtimeServicesById.set(record.id, record);
  if (record.reuseKey) {
    state.runtimeServicesByReuseKey.set(record.reuseKey, record.id);
  }

  record.child?.on("exit", (code, signal) => {
    const current = state.runtimeServicesById.get(record.id);
    if (!current) return;
    clearIdleTimer(current);
    current.status = code === 0 || signal === "SIGTERM" ? "stopped" : "failed";
    current.healthStatus = current.status === "failed" ? "unhealthy" : "unknown";
    current.lastUsedAt = new Date().toISOString();
    current.stoppedAt = new Date().toISOString();
    state.runtimeServicesById.delete(current.id);
    if (current.reuseKey && state.runtimeServicesByReuseKey.get(current.reuseKey) === current.id) {
      state.runtimeServicesByReuseKey.delete(current.reuseKey);
    }
    void persistRuntimeServiceRecord(db, current);
  });
}

async function ensureRuntimeServicesForRunWithState(state: WorkspaceRuntimeState, input: {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<RuntimeServiceRef[]> {
  const runtime = parseObject(input.config.workspaceRuntime);
  const rawServices = Array.isArray(runtime.services)
    ? runtime.services.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const acquiredServiceIds: string[] = [];
  const refs: RuntimeServiceRef[] = [];
  state.runtimeServiceLeasesByRun.set(input.runId, acquiredServiceIds);

  try {
    for (const service of rawServices) {
      const lifecycle = asString(service.lifecycle, "shared") === "ephemeral" ? "ephemeral" : "shared";
      const { scopeType, scopeId } = resolveServiceScopeId({
        service,
        workspace: input.workspace,
        issue: input.issue,
        runId: input.runId,
        agent: input.agent,
      });
      const envConfig = parseObject(service.env);
      const envFingerprint = createHash("sha256").update(stableStringify(envConfig)).digest("hex");
      const serviceName = asString(service.name, "service");
      const reuseKey =
        lifecycle === "shared"
          ? [scopeType, scopeId ?? "", serviceName, envFingerprint].join(":")
          : null;

      if (reuseKey) {
        const existingId = state.runtimeServicesByReuseKey.get(reuseKey);
        const existing = existingId ? state.runtimeServicesById.get(existingId) : null;
        if (existing && existing.status === "running") {
          existing.leaseRunIds.add(input.runId);
          existing.lastUsedAt = new Date().toISOString();
          existing.stoppedAt = null;
          clearIdleTimer(existing);
          await persistRuntimeServiceRecord(input.db, existing);
          acquiredServiceIds.push(existing.id);
          refs.push(toRuntimeServiceRef(existing, { reused: true }));
          continue;
        }
      }

      const record = await startLocalRuntimeService({
        db: input.db,
        runId: input.runId,
        agent: input.agent,
        issue: input.issue,
        workspace: input.workspace,
        adapterEnv: input.adapterEnv,
        service,
        onLog: input.onLog,
        reuseKey,
        scopeType,
        scopeId,
      });
      registerRuntimeService(state, input.db, record);
      await persistRuntimeServiceRecord(input.db, record);
      acquiredServiceIds.push(record.id);
      refs.push(toRuntimeServiceRef(record));
    }
  } catch (err) {
    await releaseRuntimeServicesForRunWithState(state, input.runId);
    throw err;
  }

  return refs;
}

async function releaseRuntimeServicesForRunWithState(state: WorkspaceRuntimeState, runId: string) {
  const acquired = state.runtimeServiceLeasesByRun.get(runId) ?? [];
  state.runtimeServiceLeasesByRun.delete(runId);
  for (const serviceId of acquired) {
    const record = state.runtimeServicesById.get(serviceId);
    if (!record) continue;
    record.leaseRunIds.delete(runId);
    record.lastUsedAt = new Date().toISOString();
    const stopType = asString(record.stopPolicy?.type, record.lifecycle === "ephemeral" ? "on_run_finish" : "manual");
    await persistRuntimeServiceRecord(record.db, record);
    if (record.leaseRunIds.size === 0) {
      if (record.lifecycle === "ephemeral" || stopType === "on_run_finish") {
        await stopRuntimeService(state, serviceId);
        continue;
      }
      scheduleIdleStop(state, record);
    }
  }
}

export async function ensureRuntimeServicesForRun(input: {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<RuntimeServiceRef[]> {
  return defaultWorkspaceRuntimeManager.ensureRuntimeServicesForRun(input);
}

export async function releaseRuntimeServicesForRun(runId: string): Promise<void> {
  await defaultWorkspaceRuntimeManager.releaseRuntimeServicesForRun(runId);
}

export async function listWorkspaceRuntimeServicesForProjectWorkspaces(
  db: Db,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId);
    if (existing) existing.push(row);
    else grouped.set(row.projectWorkspaceId, [row]);
  }
  return grouped;
}

export async function reconcilePersistedRuntimeServicesOnStartup(db: Db) {
  const staleRows = await db
    .select({ id: workspaceRuntimeServices.id })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["starting", "running"]),
      ),
    );

  if (staleRows.length === 0) return { reconciled: 0 };

  const now = new Date();
  await db
    .update(workspaceRuntimeServices)
    .set({
      status: "stopped",
      healthStatus: "unknown",
      stoppedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["starting", "running"]),
      ),
    );

  return { reconciled: staleRows.length };
}

export async function persistAdapterManagedRuntimeServices(input: {
  db: Db;
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  reports: AdapterRuntimeServiceReport[];
}) {
  const refs = normalizeAdapterManagedRuntimeServices(input);
  if (refs.length === 0) return refs;

  const existingRows = await input.db
    .select()
    .from(workspaceRuntimeServices)
    .where(inArray(workspaceRuntimeServices.id, refs.map((ref) => ref.id)));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const ref of refs) {
    const existing = existingById.get(ref.id);
    const startedAt = existing?.startedAt ?? new Date(ref.startedAt);
    const createdAt = existing?.createdAt ?? new Date();
    await input.db
      .insert(workspaceRuntimeServices)
      .values({
        id: ref.id,
        companyId: ref.companyId,
        projectId: ref.projectId,
        projectWorkspaceId: ref.projectWorkspaceId,
        issueId: ref.issueId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        serviceName: ref.serviceName,
        status: ref.status,
        lifecycle: ref.lifecycle,
        reuseKey: ref.reuseKey,
        command: ref.command,
        cwd: ref.cwd,
        port: ref.port,
        url: ref.url,
        provider: ref.provider,
        providerRef: ref.providerRef,
        ownerAgentId: ref.ownerAgentId,
        startedByRunId: ref.startedByRunId,
        lastUsedAt: new Date(ref.lastUsedAt),
        startedAt,
        stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
        stopPolicy: ref.stopPolicy,
        healthStatus: ref.healthStatus,
        createdAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceRuntimeServices.id,
        set: {
          projectId: ref.projectId,
          projectWorkspaceId: ref.projectWorkspaceId,
          issueId: ref.issueId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          serviceName: ref.serviceName,
          status: ref.status,
          lifecycle: ref.lifecycle,
          reuseKey: ref.reuseKey,
          command: ref.command,
          cwd: ref.cwd,
          port: ref.port,
          url: ref.url,
          provider: ref.provider,
          providerRef: ref.providerRef,
          ownerAgentId: ref.ownerAgentId,
          startedByRunId: ref.startedByRunId,
          lastUsedAt: new Date(ref.lastUsedAt),
          startedAt,
          stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
          stopPolicy: ref.stopPolicy,
          healthStatus: ref.healthStatus,
          updatedAt: new Date(),
        },
      });
  }

  return refs;
}

export function buildWorkspaceReadyComment(input: {
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
}) {
  const lines = ["## Workspace Ready", ""];
  lines.push(`- Strategy: \`${input.workspace.strategy}\``);
  if (input.workspace.branchName) lines.push(`- Branch: \`${input.workspace.branchName}\``);
  lines.push(`- CWD: \`${input.workspace.cwd}\``);
  if (input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd) {
    lines.push(`- Worktree: \`${input.workspace.worktreePath}\``);
  }
  for (const service of input.runtimeServices) {
    const detail = service.url ? `${service.serviceName}: ${service.url}` : `${service.serviceName}: running`;
    const suffix = service.reused ? " (reused)" : "";
    lines.push(`- Service: ${detail}${suffix}`);
  }
  return lines.join("\n");
}
