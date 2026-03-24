#!/usr/bin/env bash
# Build hive-worker release archives + SHA256SUMS + manifest JSON.
# Usage: ./scripts/build-release.sh v0.2.7 [--url-base https://cdn.example/hive-worker/v0.2.7]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG_RAW="${1:?tag required e.g. v0.2.7}"
shift || true

URL_BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url-base)
      URL_BASE="${2:?}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

VER="${TAG_RAW#v}"
TAG="v${VER}"
OUT="${ROOT}/dist"
STAGE="${ROOT}/dist.staging"
rm -rf "$OUT" "$STAGE"
mkdir -p "$OUT"

export CGO_ENABLED=0

pack_unix() {
  local goos="$1" goarch="$2" archive="$3"
  local d="${STAGE}/${goos}-${goarch}"
  mkdir -p "$d"
  echo "Building ${goos}/${goarch}"
  GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w" -o "${d}/hive-worker" ./cmd/worker
  tar -czf "$archive" -C "$d" hive-worker
  rm -rf "$d"
}

pack_unix linux amd64 "${OUT}/hive-worker_${TAG}_linux_amd64.tar.gz"
pack_unix linux arm64 "${OUT}/hive-worker_${TAG}_linux_arm64.tar.gz"
pack_unix darwin amd64 "${OUT}/hive-worker_${TAG}_darwin_amd64.tar.gz"
pack_unix darwin arm64 "${OUT}/hive-worker_${TAG}_darwin_arm64.tar.gz"

WIN_DIR="${STAGE}/windows-amd64"
mkdir -p "$WIN_DIR"
echo "Building windows/amd64"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "${WIN_DIR}/hive-worker.exe" ./cmd/worker
WIN_ZIP="${OUT}/hive-worker_${TAG}_windows_amd64.zip"
PS_BIN=""
if command -v powershell.exe >/dev/null 2>&1; then
  PS_BIN="powershell.exe"
elif [[ -f "/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" ]]; then
  PS_BIN="/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
elif [[ -f "${SYSTEMROOT:-}/System32/WindowsPowerShell/v1.0/powershell.exe" ]]; then
  PS_BIN="${SYSTEMROOT}/System32/WindowsPowerShell/v1.0/powershell.exe"
fi

if (
  cd "$WIN_DIR" &&
  command -v zip >/dev/null 2>&1 &&
  zip -qj "$WIN_ZIP" hive-worker.exe
); then
  :
elif [[ -n "$PS_BIN" ]]; then
  win_exe=""
  win_zip=""
  if win_dir="$(cd "$WIN_DIR" && pwd -W 2>/dev/null)" && win_out="$(cd "$OUT" && pwd -W 2>/dev/null)"; then
    win_exe="${win_dir}\\hive-worker.exe"
    win_zip="${win_out}\\hive-worker_${TAG}_windows_amd64.zip"
  elif command -v cygpath >/dev/null 2>&1; then
    win_exe="$(cygpath -w "$WIN_DIR/hive-worker.exe")"
    win_zip="$(cygpath -w "$WIN_ZIP")"
  fi
  if [[ -n "$win_exe" && -n "$win_zip" ]]; then
    "$PS_BIN" -NoProfile -Command "Compress-Archive -LiteralPath '$win_exe' -DestinationPath '$win_zip' -Force"
  else
    echo "Could not resolve Windows paths for hive-worker.exe (need Git Bash pwd -W or cygpath)" >&2
    exit 1
  fi
else
  echo "Need 'zip' in PATH (Linux/macOS) or PowerShell (Windows) to build the Windows archive" >&2
  exit 1
fi
rm -rf "$STAGE"

SUMFILE="${OUT}/SHA256SUMS"
: > "$SUMFILE"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT" && sha256sum hive-worker_"${TAG}"_*.tar.gz hive-worker_"${TAG}"_windows_amd64.zip | sort >> "$SUMFILE")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$OUT" && shasum -a 256 hive-worker_"${TAG}"_*.tar.gz hive-worker_"${TAG}"_windows_amd64.zip | sort >> "$SUMFILE")
else
  echo "Need sha256sum or shasum in PATH" >&2
  exit 1
fi

MANIFEST="${OUT}/hive-worker_${TAG}.manifest.json"
BASE_JSON="$URL_BASE"
[[ -n "$BASE_JSON" ]] && BASE_JSON="${BASE_JSON%/}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Warning: python3 not found; skipping manifest.json (archives + SHA256SUMS are ready)." >&2
  exit 0
fi

PYBASE="$BASE_JSON" PYTAG="$TAG" ROOT_OUT="$OUT" python3 - <<'PY'
import json, os

base = os.environ.get("PYBASE", "").strip()
tag = os.environ["PYTAG"]
out_dir = os.environ["ROOT_OUT"]
names = [
  f"hive-worker_{tag}_linux_amd64.tar.gz",
  f"hive-worker_{tag}_linux_arm64.tar.gz",
  f"hive-worker_{tag}_darwin_amd64.tar.gz",
  f"hive-worker_{tag}_darwin_arm64.tar.gz",
  f"hive-worker_{tag}_windows_amd64.zip",
]
artifacts = []
for fn in names:
  item = {"filename": fn}
  if base:
    item["url"] = f"{base}/{fn}"
  artifacts.append(item)

manifest = {
  "schemaVersion": 1,
  "tag": tag,
  "artifacts": artifacts,
}
if base:
  manifest["sha256sumsUrl"] = f"{base}/SHA256SUMS"

path = os.path.join(out_dir, f"hive-worker_{tag}.manifest.json")
with open(path, "w", encoding="utf-8") as f:
  json.dump(manifest, f, indent=2)
  f.write("\n")
print("Wrote", path)
PY

echo "Done. Upload files from ${OUT}/ to your release or mirror."
