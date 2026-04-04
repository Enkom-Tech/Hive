import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { pluginManifestSchema, pluginCapabilitySchema } from "@hive/plugin-sdk";
import { assertCompanyPermission, assertCompanyRead } from "./authz.js";
import { pluginRegistryService } from "../services/plugins.js";

const registerBodySchema = z.object({
  packageKey: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  manifest: pluginManifestSchema,
  digestSha256: z.string().optional().nullable(),
});

const patchBodySchema = z.object({
  enabled: z.boolean().optional(),
  capabilities: z.array(pluginCapabilitySchema).optional(),
});

export async function pluginBoardPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = pluginRegistryService(db);

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/plugins",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await svc.listForCompany(companyId));
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/plugins",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "plugins:manage");
      const parsed = registerBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const manifestJson = JSON.stringify(parsed.data.manifest);
      const out = await svc.registerFromManifest({
        companyId,
        packageKey: parsed.data.packageKey,
        version: parsed.data.version,
        manifest: parsed.data.manifest,
        manifestJson,
        digestSha256: parsed.data.digestSha256,
      });
      if (!out) return reply.status(404).send({ error: "Company not found" });
      return reply.status(201).send(out);
    },
  );

  fastify.patch<{ Params: { companyId: string; instanceId: string } }>(
    "/api/companies/:companyId/plugins/:instanceId",
    async (req, reply) => {
      const { companyId, instanceId } = req.params;
      await assertCompanyPermission(db, req, companyId, "plugins:manage");
      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const updated = await svc.patchInstance({
        companyId,
        instanceId,
        enabled: parsed.data.enabled,
        capabilities: parsed.data.capabilities,
      });
      if (!updated) return reply.status(404).send({ error: "Plugin instance not found" });
      return reply.send({ ok: true });
    },
  );
}
