# ADR 004: Drone-first provisioning and dynamic worker–instance bindings

## Status

Accepted. Complements [ADR 003](./003-unified-managed-worker-links.md) (instance-keyed registry and dispatch).

## Context

Operators need to:

1. Install `hive-worker` on a host with a **single bootstrap secret** without pre-creating a board identity or embedding `agentId` in install URLs.
2. **Attach** `managed_worker` identities from the board later, without SSH or env changes on the host.
3. Keep **one code path** for `worker_instance_agents`: explicit attach API, assignment/move flows, and worker `hello` must not diverge.

Prior to this ADR, link enrollment was either **agent-scoped** or **instance-scoped** (existing `worker_instances` row). Historically, bindings were often established when an **agent-scoped** connection sent `hello` (`applyWorkerHello`). **Superseded by [ADR 005](./005-fleet-identity-assignment.md):** `applyWorkerHello` no longer writes `worker_instance_agents`; assignment is explicit (API or automatic placement). The in-memory registry still refreshes from DB via `syncWorkerInstanceBindings` when bindings change.

## Decision

1. **Drone provisioning tokens** — New table `drone_provisioning_tokens`: `company_id`, hashed secret, TTL, `consumed_at`. Minted by board users with company access. **High sensitivity**: allows attaching an unknown host to the company fleet; rate-limited like other enrollment mints.

2. **Link auth `provision`** — WebSocket upgrade validates provisioning token (not consumed yet). Connection opens with `LinkAuth { kind: "provision"; companyId; provisioningEnrollmentId }`. **First valid `hello`** with a UUID `instanceId` upserts `worker_instances` by `stable_instance_id` **without** updating an agent row, then **consumes** the token, registers the socket on `registryByInstance` under the internal `worker_instances.id`, and loads `agentIds` from `worker_instance_agents` (often empty).

3. **`applyProvisionWorkerHello` / `upsertWorkerInstanceFromHello`** — Shared instance upsert logic alongside per-agent `applyWorkerHello` (metadata + instance row only; no assignment writes per ADR 005).

4. **Dynamic bindings** — Any change to `worker_instance_agents` (API bind/unbind/move, or future placement) calls **`syncWorkerInstanceBindings(workerInstanceRowId)`**, which reloads agent ids from the DB and updates `conn.agentIds` and `agentToInstance` for the open socket. **No reconnect** required for dispatch to see new bindings.

5. **Backward compatibility** — Agent-scoped and instance-scoped enrollment (ADR 003) unchanged. Provision is a third enrollment path.

## Consequences

- **Worker binary** — Supports provision mode: `HIVE_DRONE_PROVISION_TOKEN` (or bearer token only) without `HIVE_AGENT_ID` for the primary link.
- **Threat model** — Extended in `doc/plans/threat-model-managed-worker-pool.md` for stolen provisioning tokens and rogue hosts.
- **Testing** — Integration tests for bind + `sendRunToWorker` without reconnect; provision hello + bind.

## References

- [MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md)
- [threat-model-managed-worker-pool.md](../plans/threat-model-managed-worker-pool.md)
