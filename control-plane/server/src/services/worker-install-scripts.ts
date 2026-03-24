/**
 * Bash / PowerShell installers served at GET /api/worker-downloads/install.sh|.ps1
 * so operators can use `curl … | bash` / `irm … | iex`.
 */

import type { WorkerDownloadsResponse, WorkerDownloadArtifact } from "./worker-downloads.js";

/** Options baked into generated install scripts (pipe + optional `hive-worker pair`). */
export type WorkerInstallScriptBuildOptions = {
  /** Public HTTP origin of the board (no `/api`); defaults `HIVE_CONTROL_PLANE_URL` when pairing. */
  boardHttpOrigin: string;
  /** When set (e.g. `install.sh?agentId=`), used if `HIVE_AGENT_ID` is unset while pairing. */
  defaultAgentId?: string;
};

function bashSq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function psSq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Map uname -s + uname -m to a tar.gz artifact. */
function unameCase(a: WorkerDownloadArtifact): string | null {
  if (!a.filename.endsWith(".tar.gz")) return null;
  const k = `${a.platform}/${a.arch}`;
  if (k === "linux/amd64") return "Linux/x86_64";
  if (k === "linux/arm64") return "Linux/aarch64";
  if (k === "darwin/amd64") return "Darwin/x86_64";
  if (k === "darwin/arm64") return "Darwin/arm64";
  return null;
}

export function buildWorkerInstallBashScript(
  payload: WorkerDownloadsResponse,
  options?: WorkerInstallScriptBuildOptions,
): string {
  const arms: { pat: string; url: string; file: string; sha256?: string }[] = [];
  for (const a of payload.artifacts) {
    const pat = unameCase(a);
    if (!pat) continue;
    arms.push({ pat, url: a.url, file: a.filename, sha256: a.sha256 });
  }

  if (arms.length === 0) {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'echo "No .tar.gz worker artifacts in release metadata; configure GET /api/worker-downloads" >&2',
      "exit 1",
      "",
    ].join("\n");
  }

  const originSq = bashSq(options?.boardHttpOrigin ?? "");
  const embedAgentSq = options?.defaultAgentId ? bashSq(options.defaultAgentId) : "''";

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# hive-worker ${payload.tag || "release"} (from control plane)`,
    'echo "Installing hive-worker for $(uname -s)/$(uname -m) …"',
    "case \"$(uname -s)/$(uname -m)\" in",
  ];
  for (const { pat, url, file, sha256 } of arms) {
    lines.push(`  ${pat})`);
    lines.push(`    U=${bashSq(url)}`);
    lines.push(`    F=${bashSq(file)}`);
    lines.push(`    H=${sha256 ? bashSq(sha256) : "''"}`);
    lines.push("    ;;");
  }
  lines.push("  *)");
  lines.push(
    '    echo "Unsupported OS/arch for this installer. On Windows use PowerShell: irm <board>/api/worker-downloads/install.ps1 | iex" >&2',
  );
  lines.push("    exit 1");
  lines.push("    ;;");
  lines.push("esac");
  lines.push("hive_worker_verify_sha256() {");
  lines.push("  local want=\"$1\"");
  lines.push("  local file=\"$2\"");
  lines.push("  [ -n \"$want\" ] || return 0");
  lines.push('  case "${HIVE_WORKER_SKIP_SHA256:-}" in 1|true|TRUE|yes|YES) return 0 ;; esac');
  lines.push("  if command -v sha256sum >/dev/null 2>&1; then");
  lines.push("    printf '%s  %s\\n' \"$want\" \"$file\" | sha256sum -c -");
  lines.push("  else");
  lines.push("    local got");
  lines.push("    got=$(shasum -a 256 \"$file\" | awk '{print $1}')");
  lines.push("    if [ \"$got\" != \"$want\" ]; then");
  lines.push('      echo "SHA256 mismatch for downloaded archive" >&2');
  lines.push("      return 1");
  lines.push("    fi");
  lines.push("  fi");
  lines.push("}");
  lines.push("TMP=\"$(mktemp)\"");
  lines.push("trap 'rm -f \"$TMP\"' EXIT");
  lines.push("curl -fsSL \"$U\" -o \"$TMP\"");
  lines.push('hive_worker_verify_sha256 "${H:-}" "$TMP"');
  lines.push("tar xzf \"$TMP\"");
  lines.push("chmod +x hive-worker 2>/dev/null || true");
  lines.push(`HIVE_BOARD_HTTP_ORIGIN=${originSq}`);
  lines.push(`HIVE_EMBED_AGENT_ID=${embedAgentSq}`);
    // EXTRACT_ONLY: keep binary in $PWD (CI / legacy)
  lines.push("EXTRACT_ONLY=false");
  lines.push('case "${HIVE_WORKER_EXTRACT_ONLY:-}" in 1|true|TRUE|yes|YES) EXTRACT_ONLY=true ;; esac');
  lines.push('if [ "$EXTRACT_ONLY" = true ]; then');
  lines.push('  echo "hive-worker extracted in $(pwd) (HIVE_WORKER_EXTRACT_ONLY=1 — not added to PATH)"');
  lines.push('  MAIN_BIN="$(pwd)/hive-worker"');
  lines.push("else");
  lines.push('  INSTALL_DIR="${HIVE_WORKER_INSTALL_DIR:-$HOME/.local/bin}"');
  lines.push('  mkdir -p "$INSTALL_DIR"');
  lines.push('  mv -f hive-worker "$INSTALL_DIR/hive-worker"');
  lines.push('  chmod +x "$INSTALL_DIR/hive-worker"');
  lines.push('  ( cd "$INSTALL_DIR" && ln -sf hive-worker worker && ln -sf hive-worker drone )');
  lines.push('  MAIN_BIN="$INSTALL_DIR/hive-worker"');
  lines.push("  hive_worker_ensure_path() {");
  lines.push('    local f="$1"');
  lines.push('    local dir="$2"');
  lines.push('    [ -n "$f" ] || return 0');
  lines.push('    mkdir -p "$(dirname "$f")"');
  lines.push('    touch "$f"');
  lines.push('    if grep -qF "# hive-worker PATH" "$f" 2>/dev/null; then return 0; fi');
  lines.push("    {");
  lines.push('      echo ""');
  lines.push('      echo "# hive-worker PATH (managed by hive install.sh; safe to remove)"');
  // bash expands ${dir} when the function runs; \\$PATH becomes literal $PATH in the rc file
  lines.push('      echo "export PATH=\\"${dir}:\\$PATH\\""');
  lines.push('    } >> "$f"');
  lines.push("  }");
  lines.push('  hive_worker_ensure_path "$HOME/.profile" "$INSTALL_DIR"');
  lines.push('  if [ -f "$HOME/.zshrc" ] || [[ "${SHELL:-}" == *zsh ]]; then');
  lines.push('    if [ -f "$HOME/.zshrc" ]; then');
  lines.push('      hive_worker_ensure_path "$HOME/.zshrc" "$INSTALL_DIR"');
  lines.push("    else");
  lines.push('      hive_worker_ensure_path "$HOME/.zprofile" "$INSTALL_DIR"');
  lines.push("    fi");
  lines.push("  fi");
  lines.push('  if [ -f "$HOME/.bashrc" ] || [[ "${SHELL:-}" == *bash ]]; then');
  lines.push('    hive_worker_ensure_path "$HOME/.bashrc" "$INSTALL_DIR"');
  lines.push("  fi");
  lines.push(
    '  echo "Installed hive-worker, worker, and drone to $INSTALL_DIR — open a new terminal or source your shell rc file for PATH."',
  );
  lines.push("fi");
  lines.push('if [ "${HIVE_PAIRING:-}" = "1" ]; then');
  lines.push('  if [ -n "${HIVE_EMBED_AGENT_ID}" ] && [ -z "${HIVE_AGENT_ID:-}" ]; then');
  lines.push('    export HIVE_AGENT_ID="${HIVE_EMBED_AGENT_ID}"');
  lines.push("  fi");
  lines.push('  if [ -z "${HIVE_AGENT_ID:-}" ]; then');
  lines.push(
    '    echo "HIVE_PAIRING=1 requires HIVE_AGENT_ID (export it or use install.sh?agentId=…)." >&2',
  );
  lines.push("    exit 1");
  lines.push("  fi");
  lines.push('  if [ -z "${HIVE_CONTROL_PLANE_URL:-}" ]; then');
  lines.push('    if [ -z "${HIVE_BOARD_HTTP_ORIGIN}" ]; then');
  lines.push(
    '      echo "Set HIVE_CONTROL_PLANE_URL or download install.sh with a correct board Host / reverse-proxy headers." >&2',
  );
  lines.push("      exit 1");
  lines.push("    fi");
  lines.push('    export HIVE_CONTROL_PLANE_URL="${HIVE_BOARD_HTTP_ORIGIN}"');
  lines.push("  fi");
  lines.push('  echo "Running hive-worker pair (Ctrl+C to cancel)…" >&2');
  lines.push('  exec "$MAIN_BIN" pair');
  lines.push("fi");
  lines.push(
    'if [ -n "${HIVE_DRONE_PROVISION_TOKEN:-}" ] && [ "${HIVE_PAIRING:-}" != "1" ]; then',
  );
  lines.push('  if [ -z "${HIVE_CONTROL_PLANE_URL:-}" ]; then');
  lines.push('    if [ -z "${HIVE_BOARD_HTTP_ORIGIN}" ]; then');
  lines.push(
    '      echo "HIVE_DRONE_PROVISION_TOKEN requires HIVE_CONTROL_PLANE_URL (export it) or install.sh from this board so HIVE_BOARD_HTTP_ORIGIN is set." >&2',
  );
  lines.push("      exit 1");
  lines.push("    fi");
  lines.push('    export HIVE_CONTROL_PLANE_URL="${HIVE_BOARD_HTTP_ORIGIN}"');
  lines.push("  fi");
  lines.push(
    '  echo "Starting hive-worker (WebSocket link; see link: lines below — Ctrl+C to stop)…" >&2',
  );
  lines.push('  exec "$MAIN_BIN"');
  lines.push("fi");
  lines.push("");
  return lines.join("\n");
}

export function buildWorkerInstallPowerShellScript(
  payload: WorkerDownloadsResponse,
  options?: WorkerInstallScriptBuildOptions,
): string {
  const zip = payload.artifacts.find((a) => a.filename.endsWith(".zip") && a.platform === "windows");
  if (!zip) {
    return [
      "$ErrorActionPreference = 'Stop'",
      "Write-Error 'No Windows .zip worker artifact in release metadata; configure GET /api/worker-downloads'",
      "exit 1",
      "",
    ].join("\r\n");
  }

  const u = psSq(zip.url);
  const f = psSq(zip.filename);

  const originPs = psSq(options?.boardHttpOrigin ?? "");
  const embedPs = options?.defaultAgentId ? psSq(options.defaultAgentId) : "''";
  const expectedShaPs = zip.sha256 ? psSq(zip.sha256) : "$null";

  return [
    "$ErrorActionPreference = 'Stop'",
    `# hive-worker ${payload.tag || "release"} (from control plane)`,
    "if ($env:OS -notmatch 'Windows') { Write-Error 'This installer is for Windows only.'; exit 1 }",
    `$uri = ${u}`,
    `$zip = ${f}`,
    `$HiveBoardHttpOrigin = ${originPs}`,
    `$HiveEmbedAgentId = ${embedPs}`,
    `$ExpectedSha256 = ${expectedShaPs}`,
    "Write-Host 'Downloading hive-worker…'",
    "Invoke-WebRequest -Uri $uri -OutFile $zip",
    "if ($ExpectedSha256 -and $env:HIVE_WORKER_SKIP_SHA256 -ne '1') {",
    "  $h = Get-FileHash -Path $zip -Algorithm SHA256",
    "  if ($h.Hash.ToLower() -ne $ExpectedSha256.ToLower()) { Write-Error 'SHA256 mismatch for downloaded archive'; exit 1 }",
    "}",
    "Expand-Archive -Path $zip -DestinationPath $PWD -Force",
    "Remove-Item -Force $zip",
    "$extractOnly = @('1','true','TRUE','yes','YES') -contains $env:HIVE_WORKER_EXTRACT_ONLY",
    "if ($extractOnly) {",
    "  Write-Host 'hive-worker.exe extracted in' $PWD '(HIVE_WORKER_EXTRACT_ONLY=1 — not added to PATH)'",
    "  $mainExe = Join-Path $PWD 'hive-worker.exe'",
    "} else {",
    "  $bin = if ($env:HIVE_WORKER_INSTALL_DIR) { ($env:HIVE_WORKER_INSTALL_DIR).TrimEnd('\\').TrimEnd('/') } else { Join-Path $env:USERPROFILE '.local\\bin' }",
    "  New-Item -ItemType Directory -Force -Path $bin | Out-Null",
    "  $src = Join-Path $PWD 'hive-worker.exe'",
    "  $dst = Join-Path $bin 'hive-worker.exe'",
    "  Move-Item -LiteralPath $src -Destination $dst -Force",
    "  function Hive-WorkerAlias {",
    "    param([string]$LinkPath, [string]$TargetPath)",
    "    if (Test-Path -LiteralPath $LinkPath) { Remove-Item -LiteralPath $LinkPath -Force }",
    "    try {",
    "      New-Item -ItemType SymbolicLink -LiteralPath $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null",
    "    } catch {",
    "      Copy-Item -LiteralPath $TargetPath -Destination $LinkPath -Force",
    "    }",
    "  }",
    "  Hive-WorkerAlias (Join-Path $bin 'worker.exe') $dst",
    "  Hive-WorkerAlias (Join-Path $bin 'drone.exe') $dst",
    "  $normBin = [System.IO.Path]::GetFullPath($bin)",
    "  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "  if ($userPath) {",
    "    $parts = $userPath -split ';' | Where-Object { $_ -ne '' }",
    "    $found = $false",
    "    foreach ($p in $parts) {",
    "      try {",
    "        if ([System.IO.Path]::GetFullPath($p) -eq $normBin) { $found = $true; break }",
    "      } catch { }",
    "    }",
    "    if (-not $found) {",
    "      [Environment]::SetEnvironmentVariable('Path', ($normBin + ';' + $userPath), 'User')",
    "    }",
    "  } else {",
    "    [Environment]::SetEnvironmentVariable('Path', $normBin, 'User')",
    "  }",
    "  $procHasBin = $false",
    "  foreach ($seg in ($env:Path -split ';')) {",
    "    if (-not $seg) { continue }",
    "    try {",
    "      if ([System.IO.Path]::GetFullPath($seg) -eq $normBin) { $procHasBin = $true; break }",
    "    } catch { }",
    "  }",
    "  if (-not $procHasBin) { $env:Path = $normBin + ';' + $env:Path }",
    "  $mainExe = $dst",
    "  Write-Host \"Installed hive-worker, worker, and drone to $bin — this PowerShell session PATH updated; new terminals also use User PATH.\"",
    "}",
    "if ($env:HIVE_PAIRING -eq '1') {",
    "  if ($HiveEmbedAgentId -and -not $env:HIVE_AGENT_ID) { $env:HIVE_AGENT_ID = $HiveEmbedAgentId }",
    "  if (-not $env:HIVE_AGENT_ID) { Write-Error 'HIVE_PAIRING=1 requires HIVE_AGENT_ID (or install.ps1?agentId=…).'; exit 1 }",
    "  if (-not $env:HIVE_CONTROL_PLANE_URL) {",
    "    if (-not $HiveBoardHttpOrigin) { Write-Error 'HIVE_CONTROL_PLANE_URL is required when the script has no baked board origin.'; exit 1 }",
    "    $env:HIVE_CONTROL_PLANE_URL = $HiveBoardHttpOrigin",
    "  }",
    "  Write-Host 'Running hive-worker pair (Ctrl+C to cancel)…'",
    "  & $mainExe pair",
    "  exit $LASTEXITCODE",
    "}",
    "if ($env:HIVE_DRONE_PROVISION_TOKEN -and $env:HIVE_PAIRING -ne '1') {",
    "  if (-not $env:HIVE_CONTROL_PLANE_URL) {",
    "    if (-not $HiveBoardHttpOrigin) { Write-Error 'HIVE_DRONE_PROVISION_TOKEN requires HIVE_CONTROL_PLANE_URL or install.ps1 from this board.'; exit 1 }",
    "    $env:HIVE_CONTROL_PLANE_URL = $HiveBoardHttpOrigin",
    "  }",
    "  Write-Host 'Starting hive-worker (WebSocket link; see link: lines below — Ctrl+C to stop)…'",
    "  & $mainExe",
    "  exit $LASTEXITCODE",
    "}",
    "",
  ].join("\r\n");
}
