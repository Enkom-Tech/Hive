---
title: Worker (drone) deployment matrix
summary: Where and how to run hive-worker — VPS, containers, Kubernetes, air-gap — with one contract
---

All deployment paths use the **same runtime contract**: the `hive-worker` process dials the control plane at `GET /api/workers/link` over **WebSocket** (see [`doc/DRONE-SPEC.md`](../../doc/DRONE-SPEC.md)), authenticates with an enrollment token, agent key, or provisioning token, then sends `hello` with a stable `instanceId` where applicable.

**Identity bootstrap (agents vs drones):** provision registers **capacity** only. See [Drone VPS identity bootstrap](./drone-vps-identity-bootstrap.md) for how **`managed_worker`** rows get assigned to a new host.

**Compatibility:** Use a control-plane build and `hive-worker` release that match the unified dispatch rules in [`doc/adr/003-unified-managed-worker-links.md`](../../doc/adr/003-unified-managed-worker-links.md). Artifact names and checksums are defined in [`infra/worker/RELEASES.md`](../../../infra/worker/RELEASES.md). The server’s advertised worker tag should align with the binary you install (see `GET /api/worker-downloads/`).

## 1. VPS, bare metal, or laptop (manual binary)

| Step | Action |
|------|--------|
| Artifact | Download a release archive from `GET /api/worker-downloads/` or use the pipe installer `GET /api/worker-downloads/install.sh` (see [`infra/worker/RELEASES.md`](../../../infra/worker/RELEASES.md)). |
| Credentials | Set `HIVE_CONTROL_PLANE_URL` and one of: `HIVE_AGENT_KEY` (enrollment or long-lived key), `HIVE_DRONE_PROVISION_TOKEN` (drone-first bootstrap), or pairing (`hive-worker pair`). |
| Run | `hive-worker` under systemd, supervisord, or foreground; optional `HIVE_WORKER_STATE_DIR` for persisted `link-token`. |
| Verify | `GET http://<host>:8080/health` on the worker; on the board, **Workers** shows connection status (best-effort per API process — see [Workers API](../api/workers.md)). |

**Multi-agent on one host:** `HIVE_WORKER_LINKS_JSON` or multiple processes sharing state — see [`doc/MANAGED-WORKER-ARCHITECTURE.md`](../../doc/MANAGED-WORKER-ARCHITECTURE.md).

## 2. Container (Docker, Podman, Compose)

| Step | Action |
|------|--------|
| Image | Build from [`infra/worker/Dockerfile`](../../../infra/worker/Dockerfile) or use your registry. Prefer **pinning by digest** (`image@sha256:…`) for reproducible deploys. |
| Env | Same as binary: `HIVE_CONTROL_PLANE_URL`, credentials, `HIVE_WORKER_HTTP_ADDR` if you need a non-default listen address. |
| Networking | Outbound HTTPS/WSS to the control plane; inbound only if you scrape `/health` or `/metrics`. |
| Reference compose | [`infra/worker/docker-compose.drone.yml`](../../../infra/worker/docker-compose.drone.yml) + [`infra/worker/.env.drone.example`](../../../infra/worker/.env.drone.example) — state/workspace/cache volumes and env contract. |
| Reference systemd | [`infra/worker/hive-worker.drone.example.service`](../../../infra/worker/hive-worker.drone.example.service) |
| External provisioner | Prefer a separate init Job / one-shot container that fills **`HIVE_PROVISION_CACHE_DIR`**; keep **`HIVE_PROVISION_MANIFEST_HOOKS` off** on the worker ([`infra/worker/PROVISIONER-SPLIT.md`](../../../infra/worker/PROVISIONER-SPLIT.md)). |
| Signed manifests | Optional **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_*`** on the server; worker **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** verifies **`X-Hive-Manifest-Signature`** ([security runbook](./security-runbook.md#provision-manifest-signing-optional-ed25519)). |
| Identity automation | Board **`/worker-identity-slots`** + **`HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED`** (not `false`); pair with **`HIVE_AUTO_PLACEMENT_ENABLED`** and **`HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS`**; see [Workers API](../api/workers.md). |
| Auto-deploy bundle | **`GET .../drone-auto-deploy/profile`**; assets in [`infra/worker/auto-deploy/`](../../../infra/worker/auto-deploy/). |
| Company manifest | `GET /api/companies/{companyId}/worker-runtime/manifest` — per-tenant adapter/hook JSON; worker sets `HIVE_PROVISION_MANIFEST_URL` to this HTTPS URL (Bearer from `hive_dpv_`, link token, or agent key). See [Workers API](../api/workers.md). |

See [Docker](./docker.md) and [`doc/DOCKER.md`](../../doc/DOCKER.md) for compose-oriented examples.

## 3. Kubernetes (HiveWorkerPool operator)

| Step | Action |
|------|--------|
| CR | Create a `HiveWorkerPool` in the operator’s cluster (`spec.workerImage`, `spec.replicas`, `spec.companyRef`, optional `modelGatewayURL`, `resources`, `nodeSelector`). |
| Control plane | The operator creates **`managed_worker`** board **agent** rows and keys and deploys `hive-worker` with `HIVE_CONTROL_PLANE_URL` and agent credentials. Each row includes an **HTTP adapter** `adapterConfig.url` to the in-cluster worker **Service** as a compatibility invoke surface; **runs, cancel, and logs** still use the **outbound WebSocket** link. See [Hive worker pool operator](./hive-worker-kubernetes-operator.md). |
| Verify | Pod ready + `/health`; Workers page + operator `status`. |

## 4. Air-gapped or private mirror

| Step | Action |
|------|--------|
| Manifest | Set **`HIVE_WORKER_MANIFEST_URL`** on the control plane to HTTPS JSON ([`infra/worker/RELEASES.md`](../../../infra/worker/RELEASES.md) manifest shape). |
| Artifacts | Host archives and `SHA256SUMS` at the URLs in the manifest; operators download from your CDN, not GitHub. |
| Install script | Still served from the board; it resolves artifact URLs from the manifest. |

## 5. High availability (control plane replicas)

When **more than one** API replica runs, WebSockets attach to arbitrary instances. Set **`HIVE_WORKER_DELIVERY_BUS_URL`** to a shared **Redis-protocol** bus (Redis, Dragonfly, Valkey, or compatible) so run/cancel delivery reaches the replica that holds the socket ([`doc/adr/003-unified-managed-worker-links.md`](../../doc/adr/003-unified-managed-worker-links.md)). Single-replica installs omit it.

The board may expose whether the delivery bus is configured (see `GET /api/worker-downloads/` response). If you run multiple replicas and the bus is **not** configured, worker runs may fail to reach connected drones.

## 6. Release checklist (engineering)

Before tagging worker or shipping a control-plane release that changes the link protocol:

- From [`control-plane/AGENTS.md`](../../AGENTS.md): `pnpm -r typecheck`, `pnpm test:run`, `pnpm build` in `control-plane`.
- `go test ./...` under `infra/worker` (and operator if touched).
- Update this page or [`docs/api/workers.md`](../api/workers.md) if the operator or enrollment story changes.

## Related links

- [Deployment overview](./overview.md)
- [Environment variables](./environment-variables.md) (`HIVE_WORKER_*`, `HIVE_WORKER_DELIVERY_BUS_URL`)
- [Workers API](../api/workers.md)
- [`doc/MANAGED-WORKER-ARCHITECTURE.md`](../../doc/MANAGED-WORKER-ARCHITECTURE.md)
