#!/usr/bin/env bash
# Format a JuiceFS volume for use by the Hive operator.
#
# Run once per cluster after:
#   - infra/manifests/storage is applied via Kustomize (default: RustFS + DragonflyDB; see overlays for alternatives)
#   - JuiceFS CSI driver installed (Helm; see juicefs-csi.yaml)
#   - See infra/scripts/bootstrap-vps.sh for ordering: bootstrap -> kubectl apply -k manifests/storage -> this script
#
# Before creating HiveCompany CRs that use the JuiceFS StorageClass, the filesystem
# must exist. This script runs `juicefs format` with the given metadata and storage.
#
# Inputs (env):
#   JUICEFS_NAME     - Filesystem name (default: hive-fs)
#   JUICEFS_META_URL - Metadata Redis URL; include password if Dragonfly uses requirepass, e.g.
#                      redis://:changeme-dragonfly@localhost:6379/1
#   JUICEFS_STORAGE  - JuiceFS object-store URI (S3-compatible). Examples:
#                      - Default RustFS: minio://rustfsadmin:rustfsadmin@localhost:9000/hive-juicefs
#                      - In-cluster port-forward to RustFS: same with @127.0.0.1:9000
#                      - Legacy MinIO: minio://minioadmin:minioadmin@localhost:9000/projects
#
# Usage: ./format-juicefs.sh [--dry-run]
set -e

JUICEFS_NAME="${JUICEFS_NAME:-hive-fs}"
JUICEFS_META_URL="${JUICEFS_META_URL:-}"
JUICEFS_STORAGE="${JUICEFS_STORAGE:-}"

DRY_RUN=false
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=true
done

if [ -z "$JUICEFS_META_URL" ] || [ -z "$JUICEFS_STORAGE" ]; then
  echo "Error: JUICEFS_META_URL and JUICEFS_STORAGE must be set (or passed in env)." >&2
  echo "Example (RustFS + Dragonfly, port-forward 6379/9000): \\" >&2
  echo "  JUICEFS_META_URL='redis://:changeme-dragonfly@127.0.0.1:6379/1' \\" >&2
  echo "  JUICEFS_STORAGE='minio://rustfsadmin:rustfsadmin@127.0.0.1:9000/hive-juicefs' \\" >&2
  echo "  ./format-juicefs.sh" >&2
  exit 1
fi

if ! command -v juicefs >/dev/null 2>&1; then
  echo "Error: juicefs not found in PATH. Install the JuiceFS CLI." >&2
  exit 1
fi

CMD=(juicefs format "$JUICEFS_META_URL" "$JUICEFS_NAME" "$JUICEFS_STORAGE")
if [ "$DRY_RUN" = true ]; then
  echo "[DRY-RUN] ${CMD[*]}"
  exit 0
fi

exec "${CMD[@]}"
