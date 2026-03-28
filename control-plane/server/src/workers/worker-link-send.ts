import { WebSocket } from "ws";
import {
  agentToInstance,
  findConnectionForAgent,
  pendingByAgent,
  registryByInstance,
  trySendJsonOnConnection,
  trySendJsonToWorkerInstance,
} from "./worker-link-registry.js";
import { isWorkerDeliveryRedisConfigured, publishWorkerInstanceDeliver } from "./worker-delivery-redis.js";

export function sendRunToWorker(
  agentId: string,
  message: {
    type: string;
    runId?: string;
    agentId?: string;
    adapterKey?: string;
    context?: unknown;
    /** OpenAI-style model id for model-gateway routing and cost attribution. */
    modelId?: string;
    placementId?: string;
    expectedWorkerInstanceId?: string;
    companyId?: string;
    imageRef?: string;
    expiresAt?: string;
    signature?: string;
  },
): boolean {
  const json = JSON.stringify(message);
  const inst = agentToInstance.get(agentId);
  if (inst) {
    if (trySendJsonToWorkerInstance(inst, json)) return true;
    publishWorkerInstanceDeliver(inst, json);
    return isWorkerDeliveryRedisConfigured();
  }
  const pending = pendingByAgent.get(agentId);
  if (pending) {
    return trySendJsonOnConnection(pending, json);
  }
  return false;
}

export function sendCancelToWorker(agentId: string, runId: string): boolean {
  return sendRunToWorker(agentId, { type: "cancel", runId });
}

/** Delivers a signed deploy_grant frame to the worker link for digest-pinned image pull (request_deploy v1). */
export function sendDeployGrantToWorker(
  agentId: string,
  message: {
    type: string;
    companyId?: string;
    imageRef?: string;
    expiresAt?: string;
    signature?: string;
  },
): boolean {
  return sendRunToWorker(agentId, message);
}

export function isAgentWorkerConnected(agentId: string): boolean {
  const c = findConnectionForAgent(agentId);
  if (!c) return false;
  return c.ws.readyState === WebSocket.OPEN;
}

export function getWorkerLinkStableInstanceId(agentId: string): string | undefined {
  const c = findConnectionForAgent(agentId);
  return c?.stableInstanceId;
}

export function getConnectedManagedWorkerAgentIdsForCompany(companyId: string): string[] {
  const ids = new Set<string>();
  for (const conn of registryByInstance.values()) {
    if (conn.companyId === companyId && conn.ws.readyState === WebSocket.OPEN) {
      for (const aid of conn.agentIds) {
        ids.add(aid);
      }
    }
  }
  for (const [aid, conn] of pendingByAgent) {
    if (conn.companyId === companyId && conn.ws.readyState === WebSocket.OPEN) {
      ids.add(aid);
    }
  }
  return [...ids];
}

/** True when this process has an open WebSocket for the worker instance row (drone link). */
export function isWorkerInstanceConnected(workerInstanceRowId: string, companyId: string): boolean {
  const c = registryByInstance.get(workerInstanceRowId);
  if (!c || c.companyId !== companyId) return false;
  return c.ws.readyState === WebSocket.OPEN;
}
