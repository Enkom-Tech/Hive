import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { getWorkerDownloads } from "../services/worker-downloads.js";
import {
  buildWorkerInstallBashScript,
  buildWorkerInstallPowerShellScript,
} from "../services/worker-install-scripts.js";
import { loadWorkerProvisionManifest } from "../services/worker-provision-manifest.js";
import {
  buildSignedProvisionManifestResponse,
  MANIFEST_SIGNATURE_HEADER,
} from "../services/worker-manifest-signature.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOptionalAgentIdQuery(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (!UUID_RE.test(id)) return undefined;
  return id;
}

export type WorkerDownloadsPluginOpts = FastifyPluginOptions & {
  authPublicBaseUrl?: string;
  workerProvisionManifestJson?: string;
  workerProvisionManifestFile?: string;
  workerProvisionManifestSigningKeyPem?: string;
};

/**
 * Fastify-native worker-downloads plugin.
 * Registers GET /worker-downloads, /worker-downloads/install.sh,
 * /worker-downloads/install.ps1, /worker-downloads/provision-manifest.
 */
export async function workerDownloadsPlugin(
  fastify: FastifyInstance,
  opts: WorkerDownloadsPluginOpts,
): Promise<void> {
  const { authPublicBaseUrl } = opts;

  function boardHttpOriginFromFastifyRequest(req: { headers: Record<string, string | string[] | undefined>; protocol?: string; hostname?: string }, baseUrl?: string): string {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = (typeof forwardedProto === "string" ? forwardedProto.split(",")[0]?.trim() : undefined)
      ?? req.protocol ?? "http";
    const forwardedHost = req.headers["x-forwarded-host"];
    const host = (typeof forwardedHost === "string" ? forwardedHost.split(",")[0]?.trim() : undefined)
      ?? req.headers["host"];
    if (host) return `${proto}://${host}`;
    return (baseUrl ?? "").trim().replace(/\/+$/, "");
  }

  fastify.get("/worker-downloads", async (_req, reply) => {
    try {
      const payload = await getWorkerDownloads();
      return reply.send(payload);
    } catch (err) {
      return reply.status(500).send({
        tag: "",
        source: "github",
        artifacts: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.get("/worker-downloads/install.sh", async (req, reply) => {
    try {
      const payload = await getWorkerDownloads();
      const defaultAgentId = parseOptionalAgentIdQuery(
        (req.query as Record<string, unknown>)["agentId"],
      );
      const boardHttpOrigin = boardHttpOriginFromFastifyRequest(
        req as Parameters<typeof boardHttpOriginFromFastifyRequest>[0],
        authPublicBaseUrl,
      );
      const body = buildWorkerInstallBashScript(payload, { boardHttpOrigin, defaultAgentId });
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "public, max-age=300")
        .send(body);
    } catch {
      return reply
        .status(503)
        .header("Content-Type", "text/plain; charset=utf-8")
        .send("#!/usr/bin/env bash\necho 'Could not build install script' >&2\nexit 1\n");
    }
  });

  fastify.get("/worker-downloads/install.ps1", async (req, reply) => {
    try {
      const payload = await getWorkerDownloads();
      const defaultAgentId = parseOptionalAgentIdQuery(
        (req.query as Record<string, unknown>)["agentId"],
      );
      const boardHttpOrigin = boardHttpOriginFromFastifyRequest(
        req as Parameters<typeof boardHttpOriginFromFastifyRequest>[0],
        authPublicBaseUrl,
      );
      const body = buildWorkerInstallPowerShellScript(payload, { boardHttpOrigin, defaultAgentId });
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "public, max-age=300")
        .send(body);
    } catch {
      return reply
        .status(503)
        .header("Content-Type", "text/plain; charset=utf-8")
        .send("$ErrorActionPreference = 'Stop'\nWrite-Error 'install.ps1 unavailable'\nexit 1\n");
    }
  });

  fastify.get("/worker-downloads/provision-manifest", async (_req, reply) => {
    try {
      const manifest = await loadWorkerProvisionManifest({
        inlineJson: opts.workerProvisionManifestJson,
        filePath: opts.workerProvisionManifestFile,
      });
      if (!manifest) {
        return reply.status(404).send({ error: "Provision manifest not configured" });
      }
      const { body, signatureHeader } = buildSignedProvisionManifestResponse(
        manifest,
        opts.workerProvisionManifestSigningKeyPem,
      );
      if (signatureHeader) {
        reply.header(MANIFEST_SIGNATURE_HEADER, signatureHeader);
      }
      return reply
        .header("Cache-Control", "public, max-age=120")
        .type("application/json")
        .send(body);
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
