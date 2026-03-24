# Scripts reference

Scripts in `infra/scripts/` and when to use them.

| Script | Purpose | Usage | Env / notes |
|--------|---------|--------|-------------|
| **install-wsl2-toolchain.sh** | One-time WSL2 toolchain: Go, make, Docker, kubectl, k3d, golangci-lint, kubeconform, gosec, govulncheck, envtest | From repo root: `bash infra/scripts/install-wsl2-toolchain.sh`. From `infra/`: `bash scripts/install-wsl2-toolchain.sh`. Uses sudo. After run, ensure PATH includes `/usr/local/go/bin` and `$(go env GOPATH)/bin`. | Optional: `GO_VERSION` (default 1.26.1), `ARCH` (default linux-amd64) |
| **bootstrap-vps.sh** | Bootstrap a VPS: install K3s server, create hive-system and hive-storage namespaces | From `infra/`: `./scripts/bootstrap-vps.sh [--dry-run]`. Next: `kubectl apply -f manifests/storage/` | None |
| **join-desktop.sh** | Join a desktop machine to an existing K3s cluster as an agent node | From `infra/`: `./scripts/join-desktop.sh <K3S_URL> <K3S_TOKEN> [--dry-run]`. Run in WSL2 on the desktop. After join: `kubectl label node $(hostname) hive.io/location=local` | None |
| **create-tenant.sh** | Create HiveCompany + HiveWorkerPool CRs for a tenant | From `infra/`: `./scripts/create-tenant.sh --company-id <UUID> [--replicas N] [--dry-run]` | None |
| **format-juicefs.sh** | Format a JuiceFS volume for the operator. Run once per cluster after storage manifests are applied; required before HiveCompany CRs that use JuiceFS StorageClass | From `infra/`: `JUICEFS_META_URL=... JUICEFS_STORAGE=... ./scripts/format-juicefs.sh [--dry-run]` | **Required:** `JUICEFS_META_URL` (e.g. redis://localhost:6379/0), `JUICEFS_STORAGE` (e.g. minio://bucket). Optional: `JUICEFS_NAME` (default hive-fs). JuiceFS CLI must be in PATH. |

Order for a new cluster (run from `infra/`): bootstrap-vps → apply `manifests/storage/` → format-juicefs → deploy operator → create-tenant.

For full k3s + LLM setup (vLLM, model gateway, LM Studio), see [control-plane/doc/K3S-LLM-DEPLOYMENT.md](../control-plane/doc/K3S-LLM-DEPLOYMENT.md).
