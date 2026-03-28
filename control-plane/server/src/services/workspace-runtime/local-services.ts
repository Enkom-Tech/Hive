import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@hive/db";
import { asNumber, asString, parseObject, renderTemplate } from "../../adapters/utils.js";
import { persistRuntimeServiceRecord } from "./persist.js";
import { resolveConfiguredPath } from "./path-utils.js";
import {
  allocatePort,
  buildTemplateData,
  resolveServiceScopeId,
  waitForReadiness,
} from "./service-template.js";
import { stableStringify, toRuntimeServiceRef } from "./stable-ref.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceIssueRef,
  RealizedExecutionWorkspace,
  RuntimeServiceRecord,
  RuntimeServiceRef,
  WorkspaceRuntimeState,
} from "./types.js";

function clearIdleTimer(record: RuntimeServiceRecord) {
  if (!record.idleTimer) return;
  clearTimeout(record.idleTimer);
  record.idleTimer = null;
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

function scheduleIdleStop(state: WorkspaceRuntimeState, record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const stopType = asString(record.stopPolicy?.type, "manual");
  if (stopType !== "idle_timeout") return;
  const idleSeconds = Math.max(1, asNumber(record.stopPolicy?.idleSeconds, 1800));
  record.idleTimer = setTimeout(() => {
    stopRuntimeService(state, record.id).catch(() => undefined);
  }, idleSeconds * 1000);
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

export async function ensureRuntimeServicesForRunWithState(state: WorkspaceRuntimeState, input: {
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

export async function releaseRuntimeServicesForRunWithState(state: WorkspaceRuntimeState, runId: string) {
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
