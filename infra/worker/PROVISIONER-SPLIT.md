# External provisioner vs in-process hooks

`hive-worker` can install adapter runtimes in two ways:

1. **In-process (optional):** `HIVE_PROVISION_MANIFEST_HOOKS=1` runs `apt` / `npm` / `docker` at startup from the provision manifest. Requires a **non-distroless** image with those tools on `PATH` (see [`Dockerfile`](Dockerfile)).
2. **External provisioner (recommended for production):** A separate **init Job**, **sidecar**, or **CI-built image** populates `HIVE_PROVISION_CACHE_DIR` (and optional extra paths) before or without giving the worker package-manager capabilities.

## Contract

- The worker only needs **read** access to the provision cache volume.
- Keep **`HIVE_PROVISION_MANIFEST_HOOKS` unset or `0`** on the worker so it never runs elevated install commands.
- Use the same manifest JSON (from `GET /api/worker-downloads/provision-manifest` or `GET /api/companies/{id}/worker-runtime/manifest`) in your provisioner automation to download the same adapter URLs and layout expected by [`DefaultProvisioner`](../internal/provision/provision.go).

## Compose / Kubernetes patterns

- **Kubernetes:** An `initContainer` or a `Job` that mounts the same `emptyDir` or PVC as `hive-worker`, runs your install script, exits `0`, then the worker `Deployment` starts.
- **Docker Compose:** Run a one-off `docker compose run --rm provisioner` that shares the named volume with [`docker-compose.drone.yml`](docker-compose.drone.yml), then `docker compose up hive-worker`.

### Reference: init Job (Kubernetes)

Mount a shared volume at the path you pass as **`HIVE_PROVISION_CACHE_DIR`** on the worker. The Job populates adapters; the worker pod mounts the same volume **read-only** and leaves **`HIVE_PROVISION_MANIFEST_HOOKS` unset**.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: hive-provision-cache
spec:
  template:
    spec:
      restartPolicy: Never
      volumes:
        - name: prov
          emptyDir: {}
      containers:
        - name: provision
          image: your-registry/hive-provisioner:latest
          volumeMounts:
            - name: prov
              mountPath: /cache
          env:
            - name: HIVE_PROVISION_CACHE_DIR
              value: /cache
          # Run a script that downloads manifest JSON (same shape as CP) and lays out files
          # expected by DefaultProvisioner, then exits 0.
---
# Worker Deployment: mount `prov` at the same path, set HIVE_PROVISION_CACHE_DIR, omit hooks.
```

### Reference: Compose service (ordering)

Use `depends_on: { provisioner: { condition: service_completed_successfully } }` (Compose v2) so `hive-worker` starts only after the provisioner container exits 0, sharing a named volume for the cache directory.

## Signed manifests

When the control plane is configured with **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE`** (or inline key), manifest HTTP responses include **`X-Hive-Manifest-Signature`**. Workers that set **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** verify the signature before trusting manifest content. See [security runbook](../../control-plane/docs/deploy/security-runbook.md#provision-manifest-signing-optional-ed25519).
