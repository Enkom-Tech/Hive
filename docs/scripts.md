# Scripts reference

Scripts in `infra/scripts/` and when to use them.

| Script | Purpose | Usage | Env / notes |
|--------|---------|--------|-------------|
| **install-wsl2-toolchain.sh** | One-time WSL2 toolchain: Go, make, Docker, kubectl, k3d, golangci-lint, kubeconform, gosec, govulncheck, envtest | From repo root: `bash infra/scripts/install-wsl2-toolchain.sh`. From `infra/`: `bash scripts/install-wsl2-toolchain.sh`. Uses sudo. After run, ensure PATH includes `/usr/local/go/bin` and `$(go env GOPATH)/bin`. | Optional: `GO_VERSION` (default 1.26.1), `ARCH` (default linux-amd64) |
| **bootstrap-vps.sh** | Bootstrap a VPS: install K3s server, create hive-system and hive-storage namespaces | From `infra/`: `./scripts/bootstrap-vps.sh [--dry-run]`. Next: `kubectl apply -k manifests/storage` | None |
| **join-desktop.sh** | Join a desktop machine to an existing K3s cluster as an agent node | From `infra/`: `./scripts/join-desktop.sh <K3S_URL> <K3S_TOKEN> [--dry-run]`. Run in WSL2 on the desktop. After join: `kubectl label node $(hostname) hive.io/location=local` | None |
| **create-tenant.sh** | Create HiveCompany + HiveWorkerPool CRs for a tenant | From `infra/`: `./scripts/create-tenant.sh --company-id <UUID> [--replicas N] [--dry-run]` | None |
| **format-juicefs.sh** | Format a JuiceFS volume for the operator. Run once per cluster after storage Kustomize and JuiceFS CSI; required before HiveCompany CRs that use JuiceFS StorageClass | From `infra/`: `JUICEFS_META_URL=... JUICEFS_STORAGE=... ./scripts/format-juicefs.sh [--dry-run]` | **Required:** `JUICEFS_META_URL` (Dragonfly/Redis, with password in URL if used), `JUICEFS_STORAGE` (see [JuiceFS object storage](https://juicefs.com/docs/community/reference/how_to_set_up_object_storage/) — use `minio://` form for RustFS/MinIO-compatible endpoints). Optional: `JUICEFS_NAME` (default hive-fs). JuiceFS CLI must be in PATH. |
| **validate-storage-kustomize.sh** | CI-equivalent check: render every storage bundle and validate with kubeconform (no cluster) | From repo root: `bash infra/scripts/validate-storage-kustomize.sh`. Requires `kubectl` and `kubeconform` in PATH. | Optional env: `K8S_VER` (default 1.29.0). End-to-end apply is exercised in GitHub Actions (`storage-kind` job) with Kind. |

Order for a new cluster (run from `infra/`): bootstrap-vps → `kubectl apply -k manifests/storage` (or an overlay path; see [Cluster / GitOps](cluster.md)) → install JuiceFS CSI (Helm) → format-juicefs → deploy operator → create-tenant.

## JuiceFS storage stack (defaults and overlays)

The default Kustomize bundle at [`infra/manifests/storage`](../infra/manifests/storage) deploys **DragonflyDB** (metadata, Redis protocol) and **RustFS** (S3-compatible object store). **`juicefs-secret`** holds CSI settings and the **same** `access-key` / `secret-key` the object store process reads (no duplicate credential Secrets). `metaurl` must match `dragonfly-auth` when Dragonfly uses `requirepass`.

Self-contained overlays (Kustomize load restrictions require files under each overlay directory; copies are marked `SYNC` to the base):

| Overlay path | Object store | Metadata | Notes |
|--------------|--------------|----------|--------|
| `manifests/storage` (base) | RustFS in-cluster | Dragonfly in-cluster | Single-replica defaults + PDBs for clean drains |
| `manifests/storage/overlays/object-minio` | MinIO in-cluster | Dragonfly in-cluster | MinIO root user = `juicefs-secret` keys |
| `manifests/storage/overlays/meta-external` | RustFS in-cluster | External Redis URL — edit `metaurl` | |
| `manifests/storage/overlays/object-external-s3` | External S3-compatible — edit `bucket` and keys | Dragonfly in-cluster | |
| `manifests/storage/overlays/fully-external` | External S3 | External Redis | **Recommended HA path:** managed, replicated backends |

For other metadata engines supported by JuiceFS (e.g. TiKV, SQL), keep the same CSI Secret shape your JuiceFS version expects and manage manifests outside these overlays, or fork an overlay.

### Small clusters vs HA

- **Small / single-node friendly:** Base and partial overlays use **one replica** per in-cluster StatefulSet. **PodDisruptionBudgets** use `maxUnavailable: 1` so node drains and upgrades can evict the pod voluntarily without surprising stuck scheduling.
- **Real HA:** In-cluster RustFS and single-node Dragonfly are **not** multi-AZ data planes. For production HA, use **`fully-external`** (or combine `meta-external` + `object-external-s3`) and run **managed** Redis-compatible metadata (ElastiCache, Memorystore, Dragonfly Cloud, etc.) plus **durable S3** (AWS, GCS, Azure Blob with S3 interop, etc.). JuiceFS then inherits the provider’s replication and durability.
- **Do not** raise `replicas:` on the bundled RustFS or Dragonfly StatefulSets unless you are following that product’s **official clustered / replication** documentation; otherwise you get independent data directories, not one coherent volume.

### Design notes (what ops/architecture reviews usually check)

- **One credential Secret for object I/O:** `juicefs-secret` supplies `access-key` / `secret-key` to JuiceFS CSI and to RustFS or MinIO. Rotating keys means editing one Secret and rolling the StatefulSet + CSI consumers as needed.
- **Overlay drift:** Overlays embed copies marked `SYNC:` because Kustomize’s default load restrictor rejects `../` references from overlay directories. Editing base `dragonfly.yaml`, `rustfs.yaml`, `minio.yaml`, `poddisruptionbudgets.yaml`, or `namespace.yaml` requires updating matching overlay files (or accepting drift).
- **Single bundle per cluster:** Do not deploy base and an overlay together; they define the same `StatefulSet` / `Secret` names. ArgoCD (or `kubectl apply -k`) should target exactly one path.
- **CSI is out-of-band:** The storage Kustomize bundle does not install JuiceFS CSI; Helm (or your platform installer) must run first or in lockstep with your runbook so `juicefs-sc` is usable when PVCs are created.
- **Backups:** For in-cluster defaults, plan backups of PVCs (object) and Redis/AOF or provider snapshots (metadata). External overlays defer backup policy to your cloud provider plus JuiceFS metadata export per [JuiceFS ops docs](https://juicefs.com/docs/community/administration/status_check_and_maintenance/).

### Manual validation (after deploy)

With port-forwards or in-cluster `kubectl run` tooling: run `juicefs format` (this repo’s `format-juicefs.sh`), create a test PVC using `juicefs-sc`, mount a pod, write and read a file, then delete. Confirm CSI and object store logs are clean.

## Production hardening (storage)

- **TLS:** Use `https://` object endpoints and trusted certificates in `juicefs-secret` `bucket` where the store supports it; avoid plain `http://` outside lab networks.
- **Secrets:** Replace dev passwords (`changeme-dragonfly`, `rustfsadmin`, overlay placeholders) with values from Sealed Secrets, External Secrets Operator, or a vault; do not commit real credentials.
- **NetworkPolicy:** Restrict traffic so only JuiceFS CSI node/plugin components and required nodes can reach RustFS (9000) and Dragonfly (6379) in `hive-storage`.
- **Rotation:** Update `juicefs-secret`, restart the object-store StatefulSet if env vars are stale, and follow JuiceFS guidance for CSI / mount refresh.

For full k3s + LLM setup (vLLM, model gateway, LM Studio), see [control-plane/doc/K3S-LLM-DEPLOYMENT.md](../control-plane/doc/K3S-LLM-DEPLOYMENT.md).

## Worker smoke (`infra/worker/scripts`)

| Script | Purpose | Usage |
|--------|---------|--------|
| **smoke-mcp-worker-api.sh** | After a drone is enrolled: hit **`/api/worker-api/cost-report`** (curl) or **`hive-worker mcp`** stdio **`cost.report`** | Bash/WSL: `SMOKE_MODE=curl WORKER_JWT=… HIVE_AGENT_ID=… HIVE_API_BASE=https://cp/api bash infra/worker/scripts/smoke-mcp-worker-api.sh`. Optional `SMOKE_MODE=stdio` + same env as executor MCP (state dir, `HIVE_WORKER_BINARY`, jq). Missing env exits **0** with `SKIP` (CI-friendly). |
