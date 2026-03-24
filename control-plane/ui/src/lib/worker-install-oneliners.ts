/**
 * Copy-paste download + extract for hive-worker archives (see infra/worker/RELEASES.md).
 * Air-gapped / manifest URLs work as long as the URL is reachable from the operator machine.
 */

import type { WorkerDownloadArtifact } from "../api/worker-downloads";

function escapePosixSingleQuoted(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function escapePsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

export function buildPosixTarInstallOneLiner(artifact: WorkerDownloadArtifact): string | null {
  if (!artifact.filename.endsWith(".tar.gz")) return null;
  const url = escapePosixSingleQuoted(artifact.url);
  const fn = escapePosixSingleQuoted(artifact.filename);
  return `curl -fsSL '${url}' -o '${fn}' && tar xzf '${fn}' && chmod +x hive-worker && rm '${fn}'`;
}

export function buildPowerShellZipInstallOneLiner(artifact: WorkerDownloadArtifact): string | null {
  if (!artifact.filename.endsWith(".zip")) return null;
  const url = escapePsSingleQuoted(artifact.url);
  const fn = escapePsSingleQuoted(artifact.filename);
  return `Invoke-WebRequest -Uri '${url}' -OutFile '${fn}'; Expand-Archive -Path '${fn}' -DestinationPath '.' -Force; Remove-Item '${fn}'`;
}

/** POSIX from a .tar.gz artifact; PowerShell from a .zip artifact (cross-fill from list when needed). */
export function buildInstallOneLiners(
  suggested: WorkerDownloadArtifact | null,
  artifacts: WorkerDownloadArtifact[],
): { posix: string | null; powershell: string | null } {
  const list = artifacts.length > 0 ? artifacts : suggested ? [suggested] : [];
  const tar =
    suggested?.filename.endsWith(".tar.gz") ? suggested : list.find((a) => a.filename.endsWith(".tar.gz")) ?? null;
  const zip =
    suggested?.filename.endsWith(".zip") ? suggested : list.find((a) => a.filename.endsWith(".zip")) ?? null;
  return {
    posix: tar ? buildPosixTarInstallOneLiner(tar) : null,
    powershell: zip ? buildPowerShellZipInstallOneLiner(zip) : null,
  };
}
