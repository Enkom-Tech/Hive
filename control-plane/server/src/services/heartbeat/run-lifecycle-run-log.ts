import { eq, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { heartbeatRunEvents, heartbeatRuns } from "@hive/db";
import { notFound } from "../../errors.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import type { RunLogHandle } from "../run-log-store.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

export type RunLifecycleRunLogStore = {
  read(handle: RunLogHandle, opts?: { offset?: number; limitBytes?: number }): Promise<{ content: string; nextOffset?: number }>;
  append(handle: RunLogHandle, event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string }): Promise<void>;
  finalize(handle: RunLogHandle): Promise<{ bytes: number; sha256?: string; compressed: boolean }>;
};

export type RunLifecycleRunLogDeps = {
  db: Db;
  runLogStore: RunLifecycleRunLogStore;
  deferredRunLogHandles: Map<string, RunLogHandle>;
  getRun: (runId: string) => Promise<typeof heartbeatRuns.$inferSelect | null>;
  publishLiveEvent: (event: { companyId: string; type: string; payload: Record<string, unknown> }) => void;
};

export function createRunLifecycleRunLog(deps: RunLifecycleRunLogDeps) {
  const { db, runLogStore, deferredRunLogHandles, getRun, publishLiveEvent } = deps;

  function registerDeferredRunLogHandle(runId: string, handle: RunLogHandle) {
    deferredRunLogHandles.set(runId, handle);
  }

  async function finalizeAndRemoveRunLogHandle(
    runId: string,
  ): Promise<{ bytes: number; sha256?: string; compressed: boolean } | null> {
    const handle = deferredRunLogHandles.get(runId);
    if (!handle) return null;
    try {
      const summary = await runLogStore.finalize(handle);
      return summary;
    } finally {
      deferredRunLogHandles.delete(runId);
    }
  }

  async function getNextRunEventSeq(runId: string): Promise<number> {
    const rows = await db
      .select({ m: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0)` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return (rows[0]?.m ?? 0) + 1;
  }

  async function appendWorkerRunLog(
    runId: string,
    stream: "stdout" | "stderr",
    chunk: string,
    ts: string,
  ): Promise<void> {
    const handle = deferredRunLogHandles.get(runId);
    if (!handle) return;
    const sanitized = redactCurrentUserText(chunk);
    await runLogStore.append(handle, { stream, chunk: sanitized, ts });
    const run = await getRun(runId);
    if (run) {
      const payloadChunk =
        sanitized.length > MAX_LIVE_LOG_CHUNK_BYTES
          ? sanitized.slice(sanitized.length - MAX_LIVE_LOG_CHUNK_BYTES)
          : sanitized;
      publishLiveEvent({
        companyId: run.companyId,
        type: "heartbeat.run.log",
        payload: {
          runId: run.id,
          agentId: run.agentId,
          ts,
          stream,
          chunk: payloadChunk,
          truncated: payloadChunk.length !== sanitized.length,
        },
      });
    }
  }

  async function readLog(runId: string, opts?: { offset?: number; limitBytes?: number }) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (!run.logStore || !run.logRef) throw notFound("Run log not found");

    const result = await runLogStore.read(
      {
        store: run.logStore as "local_file",
        logRef: run.logRef,
      },
      opts,
    );

    return {
      runId,
      store: run.logStore,
      logRef: run.logRef,
      ...result,
      content: redactCurrentUserText(result.content),
    };
  }

  return {
    registerDeferredRunLogHandle,
    finalizeAndRemoveRunLogHandle,
    getNextRunEventSeq,
    appendWorkerRunLog,
    readLog,
  };
}
