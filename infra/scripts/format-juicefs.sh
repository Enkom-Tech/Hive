#!/usr/bin/env bash
# Format a JuiceFS volume for use by the Hive operator.
#
# Run once per cluster after:
#   - infra/manifests/storage is applied (MinIO, DragonflyDB, JuiceFS CSI driver)
#   - See infra/scripts/bootstrap-vps.sh for ordering: bootstrap -> storage manifests -> this script
#
# Before creating HiveCompany CRs that use the JuiceFS StorageClass, the filesystem
# must exist. This script runs `juicefs format` with the given metadata and storage.
#
# Inputs (env):
#   JUICEFS_NAME     - Filesystem name (default: hive-fs)
#   JUICEFS_META_URL - Metadata store URL, e.g. redis://localhost:6379/0 for DragonflyDB
#   JUICEFS_STORAGE  - Object storage URL, e.g. minio://bucket (creds via MINIO_* env if needed)
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
  echo "Example: JUICEFS_META_URL=redis://localhost:6379/0 JUICEFS_STORAGE=minio://mybucket ./format-juicefs.sh" >&2
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
