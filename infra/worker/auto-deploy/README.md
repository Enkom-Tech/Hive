# Drone auto-deploy references

These assets support the control-plane **drone auto-deploy profile** API:

`GET /api/companies/{companyId}/drone-auto-deploy/profile?target=docker|k3s`

## Flow

1. Board: define **worker identity desired-state slots** (`POST /api/companies/{id}/worker-identity-slots`) so the server can create `managed_worker` agents up to `desired_count`.
2. Enable **`HIVE_AUTO_PLACEMENT_ENABLED`** on the control plane when identities should bind to drones automatically.
3. Mint **`HIVE_DRONE_PROVISION_TOKEN`** (`hive_dpv_…`) for the company; start `hive-worker` with `HIVE_CONTROL_PLANE_URL` and company-scoped **`HIVE_PROVISION_MANIFEST_URL`** (see Workers API).
4. After provision `hello`, the server reconciles **identities then placement** (and on a periodic timer when slots have `desired_count > 0`).

## Files

| File | Purpose |
|------|---------|
| [`docker-compose.auto-drone.yml`](docker-compose.auto-drone.yml) | Single-container worker + volumes (distroless-friendly; hooks off by default). |
| [`k3s-provisioner.example.yaml`](k3s-provisioner.example.yaml) | Pattern for cache-populating Job before worker Deployment. |

## Related

- [`../PROVISIONER-SPLIT.md`](../PROVISIONER-SPLIT.md) — external provisioner vs in-process hooks.
- [`../../control-plane/docs/deploy/worker-deployment-matrix.md`](../../control-plane/docs/deploy/worker-deployment-matrix.md) — full deployment matrix.
- [`HiveWorkerPool` operator](../../control-plane/docs/deploy/hive-worker-kubernetes-operator.md) — in-cluster automation.
