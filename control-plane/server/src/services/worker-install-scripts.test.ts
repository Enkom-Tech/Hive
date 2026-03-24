import { describe, expect, it } from "vitest";
import type { WorkerDownloadsResponse } from "./worker-downloads.js";
import { buildWorkerInstallBashScript, buildWorkerInstallPowerShellScript } from "./worker-install-scripts.js";

const linuxAmd64Payload = (sha256?: string): WorkerDownloadsResponse => ({
  tag: "v1.0.0",
  source: "github",
  artifacts: [
    {
      label: "Linux (amd64)",
      platform: "linux",
      arch: "amd64",
      filename: "hive-worker_v1.0.0_linux_amd64.tar.gz",
      url: "https://releases.example/hive-worker_v1.0.0_linux_amd64.tar.gz",
      ...(sha256 ? { sha256 } : {}),
    },
  ],
});

describe("buildWorkerInstallBashScript", () => {
  it("includes sha256 verification when artifact.sha256 is set", () => {
    const hash = "a".repeat(64);
    const script = buildWorkerInstallBashScript(linuxAmd64Payload(hash), {
      boardHttpOrigin: "https://board.example",
    });
    expect(script).toContain("hive_worker_verify_sha256");
    expect(script).toContain(hash);
    expect(script).toContain('hive_worker_verify_sha256 "${H:-}" "$TMP"');
    expect(script).toContain("HIVE_WORKER_SKIP_SHA256");
  });

  it("sets empty H in case arm when no sha256 on artifacts", () => {
    const script = buildWorkerInstallBashScript(linuxAmd64Payload(), {
      boardHttpOrigin: "https://board.example",
    });
    expect(script).toContain("H=''");
  });
});

describe("buildWorkerInstallPowerShellScript", () => {
  const winPayload = (sha256?: string): WorkerDownloadsResponse => ({
    tag: "v1.0.0",
    source: "github",
    artifacts: [
      {
        label: "Windows (amd64)",
        platform: "windows",
        arch: "amd64",
        filename: "hive-worker_v1.0.0_windows_amd64.zip",
        url: "https://releases.example/w.zip",
        ...(sha256 ? { sha256 } : {}),
      },
    ],
  });

  it("includes Get-FileHash when zip has sha256", () => {
    const hash = "b".repeat(64);
    const script = buildWorkerInstallPowerShellScript(winPayload(hash), {
      boardHttpOrigin: "https://board.example",
    });
    expect(script).toContain("Get-FileHash");
    expect(script).toContain(hash);
    expect(script).toContain("HIVE_WORKER_SKIP_SHA256");
  });
});
