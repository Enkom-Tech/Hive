import type { Db } from "@hive/db";

export type AgentSchedulingRow = {
  workerPlacementMode: string;
  operationalPosture: string;
  status: string;
};

export type ManagedWorkerExecuteDeps = {
  db: Db;
  placementV1Enabled: boolean;
  /** When true with agent `worker_placement_mode === "automatic"`, execute may create `worker_instance_agents` via worker-assignment (ADR 005). */
  autoPlacementEnabled: boolean;
  /** Override for tests; default loads from `agents` in bootstrap. */
  loadAgentSchedulingRow?: (db: Db, agentId: string) => Promise<AgentSchedulingRow | null>;
};

let deps: ManagedWorkerExecuteDeps | null = null;

/** Called from server bootstrap; tests leave this unset (placement off) or set mocks. */
export function setManagedWorkerExecuteDeps(next: ManagedWorkerExecuteDeps | null): void {
  deps = next;
}

export function getManagedWorkerExecuteDeps(): ManagedWorkerExecuteDeps | null {
  return deps;
}
