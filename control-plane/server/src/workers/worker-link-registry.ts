import { eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { workerInstanceAgents } from "@hive/db";
import { WebSocket } from "ws";
import { logger } from "../middleware/logger.js";

/** Outbound worker link state (single process). */
export interface WorkerConnection {
  ws: WebSocket;
  connectionId: string;
  companyId: string;
  linkMode: "agent" | "instance" | "provision";
  /** Agent-scoped enrollment primary (hello routing). */
  primaryAgentId?: string;
  /** Agents this socket may execute runs for. */
  agentIds: Set<string>;
  stableInstanceId?: string;
  workerInstanceRowId?: string;
  /** DB row id for drone_provisioning_tokens until consumed. */
  provisioningEnrollmentId?: string;
}

export const registryByInstance = new Map<string, WorkerConnection>();
export const pendingByAgent = new Map<string, WorkerConnection>();
/** agentId -> worker_instances.id (row uuid) */
export const agentToInstance = new Map<string, string>();

function removeAgentToInstanceMappings(conn: WorkerConnection): void {
  const inst = conn.workerInstanceRowId;
  if (!inst) return;
  for (const aid of conn.agentIds) {
    if (agentToInstance.get(aid) === inst) {
      agentToInstance.delete(aid);
    }
  }
}

/** Close the open WebSocket for this worker instance (e.g. operator removed the drone row). */
export function forceDisconnectWorkerInstance(workerInstanceRowId: string): void {
  const conn = registryByInstance.get(workerInstanceRowId);
  if (!conn) return;
  try {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(4002, "worker instance removed");
    }
  } catch {
    // ignore
  }
  unregisterConnection(conn);
}

export function unregisterConnection(conn: WorkerConnection): void {
  if (conn.primaryAgentId) {
    const pend = pendingByAgent.get(conn.primaryAgentId);
    if (pend?.connectionId === conn.connectionId) {
      pendingByAgent.delete(conn.primaryAgentId);
    }
  }
  if (conn.workerInstanceRowId) {
    const reg = registryByInstance.get(conn.workerInstanceRowId);
    if (reg?.connectionId === conn.connectionId) {
      registryByInstance.delete(conn.workerInstanceRowId);
    }
  }
  removeAgentToInstanceMappings(conn);
}

export function trySendJsonOnConnection(conn: WorkerConnection, json: string): boolean {
  try {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(json);
      return true;
    }
  } catch (err) {
    logger.warn({ err }, "worker link send failed");
  }
  return false;
}

export function trySendJsonToWorkerInstance(workerInstanceRowId: string, json: string): boolean {
  const conn = registryByInstance.get(workerInstanceRowId);
  if (!conn) return false;
  return trySendJsonOnConnection(conn, json);
}

export function findConnectionForAgent(agentId: string): WorkerConnection | undefined {
  const inst = agentToInstance.get(agentId);
  if (inst) {
    const c = registryByInstance.get(inst);
    if (c && c.agentIds.has(agentId)) return c;
  }
  return pendingByAgent.get(agentId);
}

/**
 * Reload `worker_instance_agents` for an instance and refresh in-memory maps so dispatch
 * sees new bindings without a WebSocket reconnect.
 */
export async function syncWorkerInstanceBindings(db: Db, workerInstanceRowId: string): Promise<void> {
  const conn = registryByInstance.get(workerInstanceRowId);
  if (!conn) return;

  const rows = await db
    .select({ agentId: workerInstanceAgents.agentId })
    .from(workerInstanceAgents)
    .where(eq(workerInstanceAgents.workerInstanceId, workerInstanceRowId));

  const newIds = new Set(rows.map((r) => r.agentId));
  const prev = [...conn.agentIds];
  for (const aid of prev) {
    if (!newIds.has(aid) && agentToInstance.get(aid) === workerInstanceRowId) {
      agentToInstance.delete(aid);
    }
  }
  conn.agentIds.clear();
  for (const aid of newIds) {
    conn.agentIds.add(aid);
    agentToInstance.set(aid, workerInstanceRowId);
  }
}
