#!/usr/bin/env bash
# Bootstrap VPS: K3s server, MinIO, DragonflyDB, hive-system namespace.
# Usage: ./bootstrap-vps.sh [--dry-run]
set -e
DRY_RUN=false
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=true
done
run() { [ "$DRY_RUN" = true ] && echo "[DRY-RUN] $*" || "$@"; }

[ "$DRY_RUN" = true ] && echo "[DRY-RUN] curl -sfL https://get.k3s.io | sh -s - server --disable traefik --write-kubeconfig-mode 644" || curl -sfL https://get.k3s.io | sh -s - server --disable traefik --write-kubeconfig-mode 644
run kubectl create namespace hive-system 2>/dev/null || true
run kubectl create namespace hive-storage 2>/dev/null || true
run kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: hive-storage
  labels:
    hive.io/storage: "true"
EOF
echo "Bootstrap complete. Next: kubectl apply -f manifests/storage/"
