#!/bin/sh
set -e
if [ ! -f /workspace/.bootstrapped ]; then
  if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" /workspace/repo 2>/dev/null || true
  fi
  touch /workspace/.bootstrapped
fi
exec /usr/local/bin/hive-worker
