# Hive Worker Orchestration

Kubernetes Operator and infrastructure for Hive worker orchestration (K3s, JuiceFS, DragonflyDB, GitOps).

## Development Environment (Windows + WSL2)

All operator, worker, and K8s tooling are Linux-native. On Windows 10/11 use **WSL2**:

| Tool | Windows | WSL2 | Notes |
|------|---------|------|-------|
| Go | Yes | Yes | Use WSL2 for kubebuilder and envtest |
| kubebuilder | No | **Yes** | Linux-only; scaffolding runs in WSL2 |
| envtest | No | **Yes** | etcd + kube-apiserver binaries are Linux-only |
| k3d | No | **Yes** | Requires Linux Docker socket |
| Docker | Via Docker Desktop (WSL2 backend) | Implicit | Use WSL2 backend |
| kubectl | Yes | Yes | Native Windows binary can target WSL2 k3d cluster |
| Shell scripts | No | **Yes** | `.sh` scripts require bash (WSL2 or Git Bash) |

**Recommended**: Clone the repo inside WSL2 (`/home/<user>/...`) for native I/O. Run all `make` targets from WSL2.

### One-time WSL2 setup

From repo root or from `infra/` run the install script (Debian/Ubuntu WSL2):

```bash
bash infra/scripts/install-wsl2-toolchain.sh
# or: cd infra && bash scripts/install-wsl2-toolchain.sh
```

Then ensure `PATH` includes `/usr/local/go/bin` and `$(go env GOPATH)/bin` (the script appends them to `~/.bashrc`; re-open the terminal or `source ~/.bashrc`). If `make lint` fails with `golangci-lint: command not found`, run the install script then `source ~/.bashrc` or open a new WSL terminal.

Manual option:

- **Go 1.26.1:** https://go.dev/dl/ (e.g. go1.26.1.linux-amd64.tar.gz), extract to `/usr/local/go`, add `/usr/local/go/bin` to PATH.
- **make:** `sudo apt install build-essential`
- **Docker:** Docker Desktop with WSL2 backend, or `sudo apt install docker.io` and add user to `docker` group.
- **kubectl:** `sudo apt install kubectl` or install from Kubernetes docs.
- **k3d:** Install script from https://k3d.io or use `scripts/install-wsl2-toolchain.sh`.
- **Lint/scan:** `go install` golangci-lint, kubeconform, gosec, govulncheck (see script).

**Version checklist:** Go 1.26.1 (`go version`), make, Docker 20.x+, k3d 5.x (`k3d version`), kubectl 1.28+, golangci-lint, kubeconform.

### First integration test run

`make -C infra/operator test-integration` (or `cd infra && make -C operator test-integration`) downloads ~200MB of envtest binaries (etcd + kube-apiserver) into `$KUBEBUILDER_ASSETS`. This is one-time; subsequent runs use the cache.

## Quick start (from WSL2)

From repo root:

```bash
make check-env    # Fails with instructions if not Linux/WSL
make ci           # Lint, unit tests, build, scan
make test-integration   # Optional: operator envtest (separate from ci)
make e2e          # Self-contained: builds images (operator, worker, mock), crds, k3d cluster, deploy, e2e tests (E2E_KIND=1 set automatically)
```

Or from `infra/`: `cd infra && make ci` (same targets). E2E is not run in CI; use `make e2e` from repo root (or `cd infra && make e2e`) for full cluster tests. To verify the e2e target order: `make -n e2e`. Full `make ci` and `make e2e` require the WSL2 toolchain (run `bash infra/scripts/install-wsl2-toolchain.sh` and use Go 1.26.x per go.mod).

## Layout

- **`control-plane/`** – Hive API and UI (Node.js, pnpm). REST API for companies, agents, keys; React dashboard; CLI (`hive`). The operator talks to this API. Run locally: `make control-plane-dev` or `cd control-plane && pnpm dev`. See [control-plane/README.md](control-plane/README.md). To point the operator at your local control plane, set `HiveCluster.spec.controlPlaneURL` (e.g. `http://host.docker.internal:3100` when the operator runs in Docker).
- **`infra/`** – Hive cluster infrastructure:
  - `operator/` – Go kubebuilder operator (HiveCluster, HiveCompany, HiveWorkerPool CRDs)
  - `worker/` – Go HTTP worker image (/run, /health, /metrics)
  - `e2e/` – E2E tests (k3d cluster, mock control plane)
  - `manifests/` – CRDs, storage (MinIO, Dragonfly, JuiceFS), operator Deployment, observability
  - `cluster/` – GitOps: bootstrap (ArgoCD app-of-apps), applications (operator, storage, observability, metrics-server), tenants/example
  - `scripts/` – install-wsl2-toolchain.sh, bootstrap-vps.sh, join-desktop.sh, create-tenant.sh, format-juicefs.sh
- `.github/workflows/` – CI: [hive-ci.yml](.github/workflows/hive-ci.yml) (infra), [control-plane-ci.yml](.github/workflows/control-plane-ci.yml) (control-plane)

## Docs

- [Scripts reference](docs/scripts.md) – What each script does, usage, env
- [Cluster / GitOps](docs/cluster.md) – ArgoCD layout, applications, tenants
- [infra/manifests/crds/README.md](infra/manifests/crds/README.md) – CRD source of truth and `make crds`
