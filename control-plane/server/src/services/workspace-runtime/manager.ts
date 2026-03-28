import type { Db } from "@hive/db";
import {
  ensureRuntimeServicesForRunWithState,
  releaseRuntimeServicesForRunWithState,
} from "./local-services.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceIssueRef,
  RealizedExecutionWorkspace,
  RuntimeServiceRecord,
  RuntimeServiceRef,
  WorkspaceRuntimeState,
} from "./types.js";

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

export { defaultWorkspaceRuntimeManager };
