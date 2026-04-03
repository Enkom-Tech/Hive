import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { workerDownloadsRoutes } from "../routes/worker-downloads.js";
import {
  clearWorkerDownloadsConfig,
  setWorkerDownloadsConfig,
} from "../services/worker-downloads.js";

function baseConfig(partial: Partial<Config> = {}): Config {
  return {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "",
    serveUi: true,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "",
    storageS3Bucket: "",
    storageS3Region: "",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    heartbeatSchedulerEnabled: true,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    corsAllowlist: [],
    rateLimitWindowMs: 900000,
    rateLimitMax: 200,
    runLogBasePath: "",
    attachmentAllowedTypes: "",
    attachmentMaxBytes: 10_000_000,
    releasesRepo: "Enkom-Tech/Hive",
    updateCheckDisabled: false,
    workerManifestUrl: undefined,
    workerReleasesRepo: undefined,
    workerReleaseTag: undefined,
    workerArtifactBaseUrl: undefined,
    githubToken: undefined,
    joinAllowedAdapterTypes: undefined,
    managedWorkerUrlAllowlist: undefined,
    placementV1Enabled: false,
    autoPlacementEnabled: false,
    workerIdentityAutomationEnabled: true,
    workerAutomationReconcileIntervalMs: 300_000,
    drainAutoEvacuateEnabled: false,
    drainCancelInFlightPlacementsEnabled: true,
    workerProvisionManifestJson: undefined,
    workerProvisionManifestFile: undefined,
    workerProvisionManifestSigningKeyPem: undefined,
    workerJwtSecret: undefined,
    internalHiveOperatorSecret: undefined,
    pluginHostSecret: undefined,
    e2eMcpSmokeMaterializeSecret: undefined,
    bifrostAdminBaseUrl: undefined,
    bifrostAdminToken: undefined,
    workerContainerPolicyBroadcast: undefined,
    workspaceRemoteExecGuard: false,
    vcsGitHubWebhookEnabled: false,
    vcsGitHubWebhookSecret: undefined,
    vcsGitHubAllowedRepos: undefined,
    workerDeliveryBusUrl: undefined,
    metricsEnabled: false,
    authSecret: undefined,
    trustedOriginsExtra: [],
    authProvider: "builtin",
    ...partial,
  };
}

describe("GET /api/worker-downloads", () => {
  afterEach(() => {
    clearWorkerDownloadsConfig();
    vi.unstubAllGlobals();
  });

  it("returns manifest artifacts (manifest-only mode)", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerManifestUrl: "https://internal.example/manifest.json",
      }),
    );
    const manifest = {
      schemaVersion: 1,
      tag: "v9.9.9",
      sha256sumsUrl: "https://internal.example/SHA256SUMS",
      artifacts: [
        {
          filename: "hive-worker_v9.9.9_linux_amd64.tar.gz",
          url: "https://internal.example/hive-worker_v9.9.9_linux_amd64.tar.gz",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (url.includes("SHA256SUMS")) {
          return new Response(
            "deadbeef".repeat(8) +
              "  hive-worker_v9.9.9_linux_amd64.tar.gz\n",
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("manifest");
    expect(res.body.tag).toBe("v9.9.9");
    expect(res.body.artifacts).toHaveLength(1);
    expect(res.body.artifacts[0].url).toContain("linux_amd64");
    expect(res.body.artifacts[0].sha256).toBe("deadbeef".repeat(8));
    expect(res.body.workerDeliveryBusConfigured).toBe(false);
  });

  it("includes workerDeliveryBusConfigured when HIVE_WORKER_DELIVERY_BUS_URL is set", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerManifestUrl: "https://internal.example/manifest.json",
        workerDeliveryBusUrl: "redis://127.0.0.1:6379",
      }),
    );
    const manifest = {
      schemaVersion: 1,
      tag: "v9.9.9",
      artifacts: [
        {
          filename: "hive-worker_v9.9.9_linux_amd64.tar.gz",
          url: "https://internal.example/hive-worker_v9.9.9_linux_amd64.tar.gz",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/");
    expect(res.status).toBe(200);
    expect(res.body.workerDeliveryBusConfigured).toBe(true);
  });

  it("returns GitHub assets without mirror", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerReleaseTag: "v1.0.0",
        releasesRepo: "o/r",
      }),
    );
    const gh = {
      tag_name: "v1.0.0",
      assets: [
        {
          name: "hive-worker_v1.0.0_linux_amd64.tar.gz",
          browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/a.tgz",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify(gh), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("github");
    expect(res.body.artifacts[0].url).toBe(
      "https://github.com/o/r/releases/download/v1.0.0/a.tgz",
    );
  });

  it("rewrites URLs with HIVE_WORKER_ARTIFACT_BASE_URL", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerReleaseTag: "v1.0.0",
        workerReleasesRepo: "o/r",
        workerArtifactBaseUrl: "https://cdn.example/w/v1.0.0",
      }),
    );
    const gh = {
      tag_name: "v1.0.0",
      assets: [
        {
          name: "hive-worker_v1.0.0_linux_amd64.tar.gz",
          browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/a.tgz",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify(gh), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/");
    expect(res.status).toBe(200);
    expect(res.body.artifacts[0].url).toBe(
      "https://cdn.example/w/v1.0.0/hive-worker_v1.0.0_linux_amd64.tar.gz",
    );
    expect(res.body.sha256sumsUrl).toBe("https://cdn.example/w/v1.0.0/SHA256SUMS");
  });

  it("returns error payload when GitHub fails", async () => {
    setWorkerDownloadsConfig(baseConfig({ workerReleaseTag: "v1.0.0" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 404 })),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/");
    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/GitHub HTTP/);
    expect(res.body.releasesPageUrl).toContain("github.com");
  });

  it("rejects invalid manifest schema", async () => {
    setWorkerDownloadsConfig(
      baseConfig({ workerManifestUrl: "https://x/m.json" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ schemaVersion: 2, tag: "v1", artifacts: [] }), {
          status: 200,
        }),
      ),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/");
    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/schemaVersion/);
    expect(res.body.artifacts).toEqual([]);
  });

  it("includes Authorization when HIVE_GITHUB_TOKEN set", async () => {
    setWorkerDownloadsConfig(
      baseConfig({ githubToken: "ghp_secret", workerReleasesRepo: "a/b" }),
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tag_name: "v0.0.0", assets: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    await request(app).get("/api/worker-downloads/");
    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit | undefined;
    const h = init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer ghp_secret");
  });

  it("serves install.sh with case arms for tar.gz artifacts", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerReleaseTag: "v1.0.0",
        releasesRepo: "o/r",
      }),
    );
    const gh = {
      tag_name: "v1.0.0",
      assets: [
        {
          name: "hive-worker_v1.0.0_linux_amd64.tar.gz",
          browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/linux.tgz",
        },
        {
          name: "hive-worker_v1.0.0_darwin_arm64.tar.gz",
          browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/darwin.tgz",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify(gh), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("#!/usr/bin/env bash");
    expect(res.text).toContain("Linux/x86_64");
    expect(res.text).toContain("curl -fsSL");
    expect(res.text).toContain("https://github.com/o/r/releases/download/v1.0.0/linux.tgz");
    expect(res.text).toContain("HIVE_PAIRING");
    expect(res.text).toContain('exec "$MAIN_BIN" pair');
    expect(res.text).toContain("HIVE_DRONE_PROVISION_TOKEN");
    expect(res.text).toContain('exec "$MAIN_BIN"');
    expect(res.text).toContain(".local/bin");
    expect(res.text).toContain("ln -sf hive-worker worker");
    expect(res.text).toContain("# hive-worker PATH");
    expect(res.text).toContain("HIVE_WORKER_EXTRACT_ONLY");
  });

  it("install.sh embeds agent id from ?agentId=", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerReleaseTag: "v1.0.0",
        releasesRepo: "o/r",
      }),
    );
    const gh = {
      tag_name: "v1.0.0",
      assets: [
        {
          name: "hive-worker_v1.0.0_linux_amd64.tar.gz",
          browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/linux.tgz",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify(gh), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const aid = "550e8400-e29b-41d4-a716-446655440000";
    const res = await request(app).get(
      `/api/worker-downloads/install.sh?agentId=${encodeURIComponent(aid)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(aid);
  });

  it("serves install.ps1 when a Windows zip artifact exists", async () => {
    setWorkerDownloadsConfig(
      baseConfig({
        workerReleaseTag: "v1.0.0",
        releasesRepo: "o/r",
      }),
    );
    const gh = {
      tag_name: "v1.0.0",
      assets: [
        {
          name: "hive-worker_v1.0.0_windows_amd64.zip",
          browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/w.zip",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify(gh), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const app = express();
    app.use("/api/worker-downloads", workerDownloadsRoutes());
    const res = await request(app).get("/api/worker-downloads/install.ps1");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Invoke-WebRequest");
    expect(res.text).toContain("hive-worker_v1.0.0_windows_amd64.zip");
    expect(res.text).toContain("HIVE_PAIRING");
    expect(res.text).toContain("& $mainExe pair");
    expect(res.text).toContain("HIVE_DRONE_PROVISION_TOKEN");
    expect(res.text).toContain("& $mainExe");
    expect(res.text).toContain(".local\\bin");
    expect(res.text).toContain("Hive-WorkerAlias");
    expect(res.text).toContain("SetEnvironmentVariable('Path'");
    expect(res.text).toContain("HIVE_WORKER_EXTRACT_ONLY");
    expect(res.text).toContain("$env:Path = $normBin");
    expect(res.text).toContain("$procHasBin");
  });
});
