#!/usr/bin/env bash
# Join desktop machine to K3s cluster as agent. Run in WSL2 on the desktop.
# Usage: ./join-desktop.sh <K3S_URL> <K3S_TOKEN> [--dry-run]
set -e
[ $# -lt 2 ] && { echo "Usage: $0 <K3S_URL> <K3S_TOKEN> [--dry-run]"; exit 1; }
K3S_URL=$1
K3S_TOKEN=$2
DRY_RUN=false
[ "$3" = "--dry-run" ] && DRY_RUN=true
run() { [ "$DRY_RUN" = true ] && echo "[DRY-RUN] $*" || "$@"; }

run curl -sfL https://get.k3s.io | run sh -s - agent --server "$K3S_URL" --token "$K3S_TOKEN"
echo "After join: kubectl label node \$(hostname) hive.io/location=local"
echo "Optional: kubectl taint node \$(hostname) hive.io/local=true:PreferNoSchedule"
