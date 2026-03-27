#!/usr/bin/env bash
# CI: ensure the drone reference env file documents container image enforcement for operators.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
f="$root/.env.drone.example"
for needle in HIVE_CONTAINER_IMAGE_ENFORCE HIVE_CONTAINER_IMAGE_ALLOWLIST; do
  if ! grep -q "$needle" "$f"; then
    echo "error: $f must mention $needle (production container hardening)" >&2
    exit 1
  fi
done
echo "ok: drone security hints present in .env.drone.example"
