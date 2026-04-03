import type { Db } from "@hive/db";
import type { WorkerContainerPolicyBroadcastConfig } from "./worker-container-policy.js";

export type LinkAuth =
  | { kind: "agent"; agentId: string; companyId: string }
  | { kind: "instance"; workerInstanceRowId: string; companyId: string; boundAgentIds: string[] }
  | { kind: "provision"; companyId: string; provisioningTokenRowId: string };

export type HeartbeatWorkerLink = {
  appendWorkerRunLog(
    runId: string,
    stream: "stdout" | "stderr",
    chunk: string,
    ts: string,
  ): Promise<void>;
  handleWorkerRunStatus(
    agentId: string,
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  handleWorkerPlacementAck?(agentId: string, payload: Record<string, unknown>): Promise<void>;
};

/** Mints a fresh worker-instance link enrollment secret so the drone can persist it and reconnect without reusing a one-time provision token. */
export type MintInstanceLinkToken = (
  companyId: string,
  workerInstanceId: string,
) => Promise<{ token: string; expiresAt: Date }>;

export type WorkerLinkAttachOpts = {
  db: Db;
  heartbeat: HeartbeatWorkerLink;
  mintInstanceLinkToken?: MintInstanceLinkToken;
  reconcileAutomaticAssignmentsForCompany?: (companyId: string) => Promise<{
    attempted: number;
    assigned: number;
    identityAgentsCreated?: number;
    identityErrors?: string[];
  }>;
  /** When secret + allowlist are set, signed worker_container_policy is sent after hello alongside worker_api_token. */
  workerContainerPolicyBroadcast?: WorkerContainerPolicyBroadcastConfig;
};
