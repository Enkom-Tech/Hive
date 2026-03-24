#!/usr/bin/env bash
# Join desktop machine to K3s cluster as agent. Run in WSL2 on the desktop.
# Usage: ./join-desktop.sh [<K3S_URL> <K3S_TOKEN>] [--dry-run]
# If K3S_URL and K3S_TOKEN are already set in the environment, positional args are optional.
set -e
DRY_RUN=false
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=true
done
if [ -z "$K3S_URL" ] || [ -z "$K3S_TOKEN" ]; then
  [ $# -lt 2 ] && { echo "Usage: $0 <K3S_URL> <K3S_TOKEN> [--dry-run]"; echo "Or set K3S_URL and K3S_TOKEN in the environment."; exit 1; }
  K3S_URL=$1
  K3S_TOKEN=$2
fi
run() { [ "$DRY_RUN" = true ] && echo "[DRY-RUN] $*" || "$@"; }

if [ "$DRY_RUN" = true ]; then
  echo "[DRY-RUN] curl -sfL https://get.k3s.io | sh -s - agent --server $K3S_URL --token <token>"
else
  curl -sfL https://get.k3s.io | sh -s - agent --server "$K3S_URL" --token "$K3S_TOKEN"
fi
echo "After join: kubectl label node $(hostname) hive.io/location=local"
echo "Optional: kubectl taint node $(hostname) hive.io/local=true:PreferNoSchedule"
echo "# One-liner (run on server for token): K3S_URL=https://<SERVER_IP>:6443 K3S_TOKEN=\$(cat /var/lib/rancher/k3s/server/node-token)"
