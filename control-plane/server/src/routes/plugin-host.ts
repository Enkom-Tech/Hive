import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@hive/db";
import { unauthorized } from "../errors.js";
import { pluginRegistryService } from "../services/plugins.js";

const rpcBodySchema = z.object({
  instanceId: z.string().uuid(),
  method: z.literal("ping"),
});

export async function pluginHostPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; hostSecret: string },
): Promise<void> {
  const svc = pluginRegistryService(opts.db);
  const secret = opts.hostSecret;

  function requireHostSecret(authHeader: string | undefined): void {
    const tok =
      typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : "";
    if (!tok || tok !== secret) {
      throw unauthorized("Invalid plugin host token");
    }
  }

  fastify.post<{ Body: z.infer<typeof rpcBodySchema> }>(
    "/api/internal/plugin-host/rpc",
    async (req, reply) => {
      requireHostSecret(req.headers.authorization as string | undefined);
      const { instanceId, method } = rpcBodySchema.parse(req.body);
      const row = await svc.getInstanceForRpc(instanceId);
      if (!row || !row.enabled) {
        return reply.status(404).send({ ok: false, error: "Plugin instance not found or disabled" });
      }
      const caps = svc.parseCapabilitiesJson(row.capabilitiesJson);
      if (!caps.includes("rpc.ping")) {
        return reply.status(403).send({ ok: false, error: "Missing rpc.ping capability" });
      }
      if (method === "ping") {
        return reply.send({ ok: true, method: "ping" });
      }
      return reply.status(400).send({ ok: false, error: "Unsupported method" });
    },
  );
}
