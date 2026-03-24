import { api } from "./client";

export interface WorkerPairingRequestRow {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  clientInfo: Record<string, unknown> | null;
  requestIp: string;
  createdAt: string;
  expiresAt: string;
}

/** Last hello from hive-worker (drone) for this board agent identity. */
export interface WorkerDroneInfo {
  hostname: string | null;
  os: string | null;
  arch: string | null;
  version: string | null;
  instanceId: string | null;
  lastHelloAt: string | null;
}

/** One row: board agent/employee + link + drone metadata from overview API. */
export interface BoardAgentOverviewRow {
  agentId: string;
  name: string;
  urlKey: string;
  status: string;
  /** Node-local socket state for this identity on the current API process. */
  connected: boolean;
  lastHeartbeatAt: string | null;
  pendingEnrollmentCount: number;
  drone: WorkerDroneInfo | null;
  workerInstanceId: string | null;
  /** manual | automatic — whether the control plane may pick a drone when unassigned. */
  workerPlacementMode: string;
  /** active | archived | hibernate | sandbox */
  operationalPosture: string;
  /** manual | automatic when bound; null if unassigned. */
  assignmentSource: string | null;
}

export interface DroneInstanceOverview {
  id: string;
  stableInstanceId: string;
  hostname: string | null;
  version: string | null;
  os: string | null;
  arch: string | null;
  lastHelloAt: string | null;
  lastSeenAt: string | null;
  /** Node-local socket state for this worker instance on the current API process. */
  connected: boolean;
  /** Operator-defined tags for placement (e.g. region). */
  labels: Record<string, unknown>;
  drainRequestedAt: string | null;
  capacityHint: string | null;
  boardAgents: BoardAgentOverviewRow[];
}

export interface DroneBoardOverviewResponse {
  /** Enrolled drones with nested board agents. */
  instances: DroneInstanceOverview[];
  /** Board agents not yet grouped under a hello instance id. */
  unassignedBoardAgents: BoardAgentOverviewRow[];
  /** Flat list: unassigned first, then agents under instances. */
  boardAgents: BoardAgentOverviewRow[];
}

export const workersApi = {
  overview: (companyId: string) =>
    api.get<DroneBoardOverviewResponse>(
      `/companies/${encodeURIComponent(companyId)}/drones/overview`,
    ),
  listPairingRequests: (companyId: string) =>
    api.get<{ requests: WorkerPairingRequestRow[] }>(
      `/companies/${encodeURIComponent(companyId)}/worker-pairing-requests`,
    ),
  approvePairingRequest: (agentId: string, requestId: string, companyId: string) =>
    api.post<{ ok: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/worker-pairing-requests/${encodeURIComponent(requestId)}/approve?companyId=${encodeURIComponent(companyId)}`,
      {},
    ),
  rejectPairingRequest: (agentId: string, requestId: string, companyId: string) =>
    api.post<{ ok: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/worker-pairing-requests/${encodeURIComponent(requestId)}/reject?companyId=${encodeURIComponent(companyId)}`,
      {},
    ),
  /** Board-only: one-time WebSocket enrollment for this worker instance row (shared host / pool). */
  createInstanceLinkEnrollmentToken: (
    companyId: string,
    workerInstanceId: string,
    body?: { ttlSeconds?: number },
  ) =>
    api.post<{ token: string; expiresAt: string }>(
      `/companies/${encodeURIComponent(companyId)}/worker-instances/${encodeURIComponent(workerInstanceId)}/link-enrollment-tokens`,
      body ?? {},
    ),
  /** Drone-first: bootstrap a host with no board identity yet (consumed on first hello). */
  createDroneProvisioningToken: (companyId: string, body?: { ttlSeconds?: number }) =>
    api.post<{ token: string; expiresAt: string }>(
      `/companies/${encodeURIComponent(companyId)}/drone-provisioning-tokens`,
      body ?? {},
    ),
  bindAgentToWorkerInstance: (companyId: string, workerInstanceId: string, agentId: string) =>
    api.put<void>(
      `/companies/${encodeURIComponent(companyId)}/worker-instances/${encodeURIComponent(workerInstanceId)}/agents/${encodeURIComponent(agentId)}`,
      {},
    ),
  unbindAgentFromWorkerInstance: (companyId: string, agentId: string) =>
    api.delete<void>(
      `/companies/${encodeURIComponent(companyId)}/worker-instances/agents/${encodeURIComponent(agentId)}`,
    ),
  /** Automatic placement only: circular advance to the next eligible drone (board). */
  rotateAutomaticWorkerPool: (companyId: string, agentId: string) =>
    api.post<{
      rotated: boolean;
      fromWorkerInstanceId: string | null;
      toWorkerInstanceId: string | null;
    }>(
      `/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/worker-pool/rotate`,
      {},
    ),
  patchWorkerInstance: (
    companyId: string,
    workerInstanceId: string,
    body: {
      drainRequested?: boolean;
      labels?: Record<string, unknown>;
      capacityHint?: string | null;
      displayLabel?: string | null;
    },
  ) =>
    api.patch<{
      id: string;
      stableInstanceId: string;
      labels: Record<string, unknown>;
      drainRequestedAt: string | null;
      capacityHint: string | null;
      displayLabel: string | null;
      updatedAt: string;
      drainEvacuation?: { evacuatedAgentIds: string[]; skippedAgentIds: string[] };
    }>(
      `/companies/${encodeURIComponent(companyId)}/worker-instances/${encodeURIComponent(workerInstanceId)}`,
      body,
    ),
  /** Remove enrolled drone row (disconnects open link on this server; placement rows cleared first). */
  deleteWorkerInstance: (companyId: string, workerInstanceId: string) =>
    api.delete<void>(
      `/companies/${encodeURIComponent(companyId)}/worker-instances/${encodeURIComponent(workerInstanceId)}`,
    ),
};
