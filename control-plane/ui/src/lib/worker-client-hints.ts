import type { WorkerDownloadArtifact } from "../api/worker-downloads";

/** Guess the best worker binary for this browser/OS. */
export function guessSuggestedWorkerArtifact(
  artifacts: WorkerDownloadArtifact[],
): WorkerDownloadArtifact | null {
  if (artifacts.length === 0) return null;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";

  if (/Win32|Win64|Windows/i.test(ua)) {
    const w = artifacts.find((a) => a.platform === "windows");
    if (w) return w;
  }
  if (/Mac/i.test(ua)) {
    if (/arm|aarch64/i.test(platform) || /Mac OS X 1[0-9]/.test(ua)) {
      const m = artifacts.find((a) => a.platform === "darwin" && a.arch === "arm64");
      if (m) return m;
    }
    const intel = artifacts.find((a) => a.platform === "darwin" && a.arch === "amd64");
    if (intel) return intel;
  }
  if (/Linux/i.test(ua)) {
    if (/aarch64|arm64/i.test(ua)) {
      const l = artifacts.find((a) => a.platform === "linux" && a.arch === "arm64");
      if (l) return l;
    }
    const l = artifacts.find((a) => a.platform === "linux" && a.arch === "amd64");
    if (l) return l;
  }
  return artifacts[0] ?? null;
}

/** Command name after global install (install.ps1 / install.sh put the binary on User PATH). */
export function workerBinForArtifact(a: WorkerDownloadArtifact | null): string {
  if (!a) return "hive-worker";
  return a.platform === "windows" ? "hive-worker.exe" : "hive-worker";
}

/** Origin for CLI `--api-base` when the operator uses the board from this browser tab. */
export function getBoardApiBase(): string {
  if (typeof window === "undefined") return "http://localhost:3100";
  return `${window.location.protocol}//${window.location.host}`;
}
