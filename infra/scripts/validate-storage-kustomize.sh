#!/usr/bin/env bash
# Validate all storage Kustomize bundles: render + kubeconform (no Kubernetes cluster required).
# Requires: kubectl, kubeconform in PATH (e.g. go install github.com/yannh/kubeconform/cmd/kubeconform@latest)
# Usage: from repo root: bash infra/scripts/validate-storage-kustomize.sh
#        from infra/:     bash scripts/validate-storage-kustomize.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

K8S_VER="${K8S_VER:-1.29.0}"
BUNDLES=(
  "infra/manifests/storage"
  "infra/manifests/storage/overlays/object-minio"
  "infra/manifests/storage/overlays/meta-external"
  "infra/manifests/storage/overlays/object-external-s3"
  "infra/manifests/storage/overlays/fully-external"
)

if ! command -v kubectl >/dev/null 2>&1; then
  echo "Error: kubectl not found in PATH." >&2
  exit 1
fi
if ! command -v kubeconform >/dev/null 2>&1; then
  echo "Error: kubeconform not found. Install: go install github.com/yannh/kubeconform/cmd/kubeconform@latest" >&2
  exit 1
fi

failed=0
for dir in "${BUNDLES[@]}"; do
  echo "== kustomize + kubeconform: ${dir} =="
  if ! kubectl kustomize "${dir}" | kubeconform -strict -kubernetes-version "${K8S_VER}" \
      -skip Certificate -skip CertificateSigningRequest -skip Ingress -summary -; then
    failed=1
  fi
done

if [[ "${failed}" -ne 0 ]]; then
  echo "One or more bundles failed validation." >&2
  exit 1
fi
echo "All ${#BUNDLES[@]} bundles OK."
