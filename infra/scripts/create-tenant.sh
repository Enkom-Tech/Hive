#!/usr/bin/env bash
# Create HiveCompany + HiveWorkerPool CRs for a tenant.
# Usage: ./create-tenant.sh --company-id <UUID> --replicas <N> [--dry-run]
set -e
COMPANY_ID=""
REPLICAS=1
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --company-id) COMPANY_ID=$2; shift 2 ;;
    --replicas)   REPLICAS=$2; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    *) shift ;;
  esac
done
[ -z "$COMPANY_ID" ] && { echo "Usage: $0 --company-id <UUID> [--replicas N] [--dry-run]"; exit 1; }

NAME="tenant-${COMPANY_ID%%-*}"
run() { [ "$DRY_RUN" = true ] && echo "[DRY-RUN] $*" || "$@"; }

run kubectl apply -f - <<EOF
apiVersion: hive.io/v1alpha1
kind: HiveCompany
metadata:
  name: $NAME
  namespace: hive-system
spec:
  companyId: $COMPANY_ID
  storageClass: juicefs-sc
  storageSize: 10Gi
---
apiVersion: hive.io/v1alpha1
kind: HiveWorkerPool
metadata:
  name: ${NAME}-workers
  namespace: hive-system
spec:
  companyRef: $NAME
  replicas: $REPLICAS
  workerImage: hive-worker:latest
EOF
echo "Tenant $NAME created with $REPLICAS worker(s)."
