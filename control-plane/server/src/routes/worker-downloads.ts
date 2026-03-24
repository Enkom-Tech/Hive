import { Router, type Request } from "express";
import { getWorkerDownloads } from "../services/worker-downloads.js";
import {
  buildWorkerInstallBashScript,
  buildWorkerInstallPowerShellScript,
} from "../services/worker-install-scripts.js";
import { loadWorkerProvisionManifest } from "../services/worker-provision-manifest.js";
import { sendSignedProvisionManifestJson } from "../services/worker-manifest-signature.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boardHttpOriginFromRequest(req: Request, authPublicBaseUrl?: string): string {
  const proto =
    req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (host) return `${proto}://${host}`;
  return (authPublicBaseUrl ?? "").trim().replace(/\/+$/, "");
}

function parseOptionalAgentIdQuery(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (!UUID_RE.test(id)) return undefined;
  return id;
}

export function workerDownloadsRoutes(opts?: {
  authPublicBaseUrl?: string;
  workerProvisionManifestJson?: string;
  workerProvisionManifestFile?: string;
  workerProvisionManifestSigningKeyPem?: string;
}) {
  const router = Router();
  const { authPublicBaseUrl } = opts ?? {};

  router.get("/", async (_req, res) => {
    try {
      const payload = await getWorkerDownloads();
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        tag: "",
        source: "github",
        artifacts: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get("/install.sh", async (req, res) => {
    try {
      const payload = await getWorkerDownloads();
      const defaultAgentId = parseOptionalAgentIdQuery(req.query.agentId);
      const boardHttpOrigin = boardHttpOriginFromRequest(req, authPublicBaseUrl);
      const body = buildWorkerInstallBashScript(payload, {
        boardHttpOrigin,
        defaultAgentId,
      });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(body);
    } catch {
      res
        .status(503)
        .type("text/plain")
        .send("#!/usr/bin/env bash\necho 'Could not build install script' >&2\nexit 1\n");
    }
  });

  router.get("/install.ps1", async (req, res) => {
    try {
      const payload = await getWorkerDownloads();
      const defaultAgentId = parseOptionalAgentIdQuery(req.query.agentId);
      const boardHttpOrigin = boardHttpOriginFromRequest(req, authPublicBaseUrl);
      const body = buildWorkerInstallPowerShellScript(payload, {
        boardHttpOrigin,
        defaultAgentId,
      });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(body);
    } catch {
      res.status(503).type("text/plain").send("$ErrorActionPreference = 'Stop'\nWrite-Error 'install.ps1 unavailable'\nexit 1\n");
    }
  });

  router.get("/provision-manifest", async (_req, res) => {
    try {
      const manifest = await loadWorkerProvisionManifest({
        inlineJson: opts?.workerProvisionManifestJson,
        filePath: opts?.workerProvisionManifestFile,
      });
      if (!manifest) {
        res.status(404).json({ error: "Provision manifest not configured" });
        return;
      }
      sendSignedProvisionManifestJson(res, manifest, opts?.workerProvisionManifestSigningKeyPem, () => {
        res.setHeader("Cache-Control", "public, max-age=120");
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
