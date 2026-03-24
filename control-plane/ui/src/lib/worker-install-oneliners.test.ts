import { describe, expect, it } from "vitest";
import type { WorkerDownloadArtifact } from "../api/worker-downloads";
import { buildInstallOneLiners, buildPosixTarInstallOneLiner } from "./worker-install-oneliners";

describe("worker-install-oneliners", () => {
  it("buildPosixTarInstallOneLiner escapes single quotes in URL", () => {
    const a: WorkerDownloadArtifact = {
      label: "Linux",
      platform: "linux",
      arch: "amd64",
      filename: "hive-worker_v1.0.0_linux_amd64.tar.gz",
      url: "https://example.com/a'b.tgz",
    };
    const line = buildPosixTarInstallOneLiner(a);
    expect(line).toContain("'https://example.com/a'\\''b.tgz'");
  });

  it("buildInstallOneLiners picks tar and zip from suggested and list", () => {
    const tar: WorkerDownloadArtifact = {
      label: "Linux",
      platform: "linux",
      arch: "amd64",
      filename: "hive-worker_v1.0.0_linux_amd64.tar.gz",
      url: "https://x/t.tgz",
    };
    const zip: WorkerDownloadArtifact = {
      label: "Win",
      platform: "windows",
      arch: "amd64",
      filename: "hive-worker_v1.0.0_windows_amd64.zip",
      url: "https://x/w.zip",
    };
    const out = buildInstallOneLiners(tar, [zip]);
    expect(out.posix).toContain("curl -fsSL");
    expect(out.posix).toContain("tar xzf");
    expect(out.powershell).toContain("Invoke-WebRequest");
    expect(out.powershell).toContain("Expand-Archive");
  });
});
