import type { Db } from "@hive/db";
import { agents, heartbeatRuns } from "@hive/db";
import type { AdapterExecutionResult, AdapterSessionCodec } from "../../adapters/index.js";
import type { RunLogHandle } from "../run-log-store.js";
import { issueService } from "../issues.js";
import { secretService } from "../secrets.js";

export interface AdapterExecutionDeps {
  db: Db;
  getRun: (runId: string) => Promise<(typeof heartbeatRuns.$inferSelect) | null>;
  getAgent: (agentId: string) => Promise<(typeof agents.$inferSelect) | null>;
  setRunStatus: (
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) => Promise<(typeof heartbeatRuns.$inferSelect) | null>;
  appendRunEvent: (
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) => Promise<void>;
  registerDeferredRunLogHandle: (runId: string, handle: RunLogHandle) => void;
  finalizeAndRemoveRunLogHandle: (
    runId: string,
  ) => Promise<{ bytes: number; sha256?: string; compressed: boolean } | null>;
  ensureRuntimeState: (agent: typeof agents.$inferSelect) => Promise<unknown>;
  getTaskSession: (
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) => Promise<{ sessionParamsJson: unknown; sessionDisplayId: string | null } | null>;
  runLogStore: {
    begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
    append(
      handle: RunLogHandle,
      event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
    ): Promise<void>;
    finalize(handle: RunLogHandle): Promise<{ bytes: number; sha256?: string; compressed: boolean }>;
  };
  getSessionCodec: (adapterType: string) => AdapterSessionCodec;
  issueService: ReturnType<typeof issueService>;
  secretService: ReturnType<typeof secretService>;
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
}

export interface ExecuteRunInvocationResult {
  adapterResult: AdapterExecutionResult;
  nextSessionState: {
    params: Record<string, unknown> | null;
    displayId: string | null;
    legacySessionId: string | null;
  };
  stdoutExcerpt: string;
  stderrExcerpt: string;
  logSummary: { bytes: number; sha256?: string; compressed: boolean } | null;
  completionDeferred?: boolean;
  requeueRun?: boolean;
  taskKey: string | null;
  previousSessionParams: Record<string, unknown> | null;
  previousSessionDisplayId: string | null;
  runtimeForAdapter: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    taskKey: string | null;
  };
}
