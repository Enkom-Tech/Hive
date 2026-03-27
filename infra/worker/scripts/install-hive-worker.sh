#!/usr/bin/env bash
# Verified install for hive-worker Linux amd64/arm64.
#
# Security: use HTTPS for HIVE_WORKER_MANIFEST_URL and binary URL in production; file:// is for air-gap only.
# sha256sum -c below is required — the script exits non-zero on checksum mismatch (set -e).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ORG/REPO/main/infra/worker/scripts/install-hive-worker.sh | bash -s -- --version v1.2.3
# Or with local manifest (air-gap):
#   HIVE_WORKER_MANIFEST_URL=file:///path/to/manifest.json bash install-hive-worker.sh
set -euo pipefail

VERSION="${HIVE_WORKER_VERSION:-}"
CHECKSUM_URL=""
BINARY_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${VERSION}" ]]; then
  echo "Set --version or HIVE_WORKER_VERSION" >&2
  exit 1
fi

MANIFEST="${HIVE_WORKER_MANIFEST_URL:-}"
if [[ -z "${MANIFEST}" ]]; then
  echo "Set HIVE_WORKER_MANIFEST_URL to a JSON manifest with url and sha256 for the binary." >&2
  exit 1
fi

TMP="$(mktemp)"
cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

if [[ "${MANIFEST}" == file://* ]]; then
  cp "${MANIFEST#file://}" "${TMP}"
else
  curl -fsSL "${MANIFEST}" -o "${TMP}"
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64) ARCH_KEY="linux_amd64" ;;
  aarch64) ARCH_KEY="linux_arm64" ;;
  *) echo "unsupported arch: ${ARCH}" >&2; exit 1 ;;
esac

URL="$(jq -r --arg v "${VERSION}" --arg a "${ARCH_KEY}" '.[$v][$a].url // empty' "${TMP}")"
SUM="$(jq -r --arg v "${VERSION}" --arg a "${ARCH_KEY}" '.[$v][$a].sha256 // empty' "${TMP}")"
if [[ -z "${URL}" || -z "${SUM}" ]]; then
  echo "manifest missing entry for ${VERSION} ${ARCH_KEY}" >&2
  exit 1
fi

BIN_TMP="$(mktemp)"
trap 'rm -f "${TMP}" "${BIN_TMP}"' EXIT
curl -fsSL "${URL}" -o "${BIN_TMP}"
if ! echo "${SUM}  ${BIN_TMP}" | sha256sum -c -; then
  echo "hive-worker install: SHA256 mismatch — refusing to install (remove corrupted ${BIN_TMP})" >&2
  exit 1
fi
install -m 0755 "${BIN_TMP}" "${HIVE_WORKER_INSTALL_PATH:-/usr/local/bin/hive-worker}"
echo "Installed hive-worker ${VERSION} to ${HIVE_WORKER_INSTALL_PATH:-/usr/local/bin/hive-worker}"
