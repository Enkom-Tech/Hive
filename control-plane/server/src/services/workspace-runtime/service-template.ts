import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { asNumber, asString, parseObject } from "../../adapters/utils.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceIssueRef,
  RealizedExecutionWorkspace,
} from "./types.js";

export async function allocatePort(): Promise<number> {
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

export function buildTemplateData(input: {
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

export function resolveServiceScopeId(input: {
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

export async function waitForReadiness(input: {
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
