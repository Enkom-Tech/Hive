import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import {
  SECRET_PROVIDERS,
  createSecretSchema,
  migrateSecretProviderSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@hive/shared";
import { assertBoard, assertCompanyPermission } from "./authz.js";
import { logActivity, secretProviderMigrationService, secretService } from "../services/index.js";

export async function secretsPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; defaultProvider: import("@hive/shared").SecretProvider },
): Promise<void> {
  const { db } = opts;
  const svc = secretService(db);
  const migrationSvc = secretProviderMigrationService(db);
  const provider = SECRET_PROVIDERS.includes(opts.defaultProvider) ? opts.defaultProvider : "local_encrypted";

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/secret-providers",
    async (req, reply) => {
      assertBoard(req);
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "secrets:manage");
      return reply.send(svc.listProviders());
    },
  );

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/secrets",
    async (req, reply) => {
      assertBoard(req);
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "secrets:manage");
      return reply.send(await svc.list(companyId));
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/secrets",
    async (req, reply) => {
      assertBoard(req);
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "secrets:manage");
      const parsed = createSecretSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const actorId = req.principal?.id ?? "board";
      const created = await svc.create(
        companyId,
        { name: parsed.data.name, provider: parsed.data.provider ?? provider, value: parsed.data.value, description: parsed.data.description, externalRef: parsed.data.externalRef },
        { userId: actorId, agentId: null },
      );
      await logActivity(db, { companyId, actorType: "user", actorId, action: "secret.created", entityType: "secret", entityId: created.id, details: { name: created.name, provider: created.provider } });
      return reply.status(201).send(created);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/secrets/:id/rotate",
    async (req, reply) => {
      assertBoard(req);
      const existing = await svc.getById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Secret not found" });
      await assertCompanyPermission(db, req, existing.companyId, "secrets:manage");
      const parsed = rotateSecretSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const actorId = req.principal?.id ?? "board";
      const rotated = await svc.rotate(req.params.id, { value: parsed.data.value, externalRef: parsed.data.externalRef }, { userId: actorId, agentId: null });
      await logActivity(db, { companyId: rotated.companyId, actorType: "user", actorId, action: "secret.rotated", entityType: "secret", entityId: rotated.id, details: { version: rotated.latestVersion } });
      return reply.send(rotated);
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    "/api/secrets/:id",
    async (req, reply) => {
      assertBoard(req);
      const existing = await svc.getById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Secret not found" });
      await assertCompanyPermission(db, req, existing.companyId, "secrets:manage");
      const parsed = updateSecretSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const updated = await svc.update(req.params.id, { name: parsed.data.name, description: parsed.data.description, externalRef: parsed.data.externalRef });
      if (!updated) return reply.status(404).send({ error: "Secret not found" });
      const actorId = req.principal?.id ?? "board";
      await logActivity(db, { companyId: updated.companyId, actorType: "user", actorId, action: "secret.updated", entityType: "secret", entityId: updated.id, details: { name: updated.name } });
      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/secrets/:id",
    async (req, reply) => {
      assertBoard(req);
      const existing = await svc.getById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "Secret not found" });
      await assertCompanyPermission(db, req, existing.companyId, "secrets:manage");
      const removed = await svc.remove(req.params.id);
      if (!removed) return reply.status(404).send({ error: "Secret not found" });
      const actorId = req.principal?.id ?? "board";
      await logActivity(db, { companyId: removed.companyId, actorType: "user", actorId, action: "secret.deleted", entityType: "secret", entityId: removed.id, details: { name: removed.name } });
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/secrets/migrate-provider",
    async (req, reply) => {
      assertBoard(req);
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "secrets:manage");
      const parsed = migrateSecretProviderSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const actorId = req.principal?.id ?? "board";
      const payload = { companyId, targetProvider: parsed.data.targetProvider as import("@hive/shared").SecretProvider, secretIds: parsed.data.secretIds };
      if (parsed.data.dryRun !== false) {
        return reply.send({ dryRun: true, ...await migrationSvc.dryRun(payload) });
      }
      const result = await migrationSvc.apply(payload);
      for (const item of result.items) {
        await logActivity(db, { companyId, actorType: "user", actorId, action: "secret.provider_migrated", entityType: "secret", entityId: item.secretId, details: { from: item.fromProvider, to: item.toProvider, versions: item.versionsMigrated } });
      }
      return reply.send({ dryRun: false, ...result });
    },
  );
}
