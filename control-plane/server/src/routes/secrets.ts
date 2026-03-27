import { Router } from "express";
import type { Db } from "@hive/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  migrateSecretProviderSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@hive/shared";
import { validate } from "../middleware/validate.js";
import { getCurrentPrincipal } from "../auth/principal.js";
import { assertBoard, assertCompanyPermission } from "./authz.js";
import { logActivity, secretProviderMigrationService, secretService } from "../services/index.js";

export function secretRoutes(db: Db, defaultProvider: SecretProvider) {
  const router = Router();
  const svc = secretService(db);
  const migrationSvc = secretProviderMigrationService(db);
  const provider = SECRET_PROVIDERS.includes(defaultProvider) ? defaultProvider : "local_encrypted";

  router.get("/companies/:companyId/secret-providers", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "secrets:manage");
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "secrets:manage");
    const secrets = await svc.list(companyId);
    res.json(secrets);
  });

  router.post("/companies/:companyId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "secrets:manage");

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        provider: req.body.provider ?? provider,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
      },
      { userId: getCurrentPrincipal(req)?.id ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyPermission(db, req, existing.companyId, "secrets:manage");

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
      },
      { userId: getCurrentPrincipal(req)?.id ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
  });

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyPermission(db, req, existing.companyId, "secrets:manage");

    const updated = await svc.update(id, {
      name: req.body.name,
      description: req.body.description,
      externalRef: req.body.externalRef,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await assertCompanyPermission(db, req, existing.companyId, "secrets:manage");

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  router.post(
    "/companies/:companyId/secrets/migrate-provider",
    validate(migrateSecretProviderSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "secrets:manage");
      const actorId = getCurrentPrincipal(req)?.id ?? "board";
      const payload = {
        companyId,
        targetProvider: req.body.targetProvider as SecretProvider,
        secretIds: req.body.secretIds as string[] | undefined,
      };

      if (req.body.dryRun !== false) {
        const result = await migrationSvc.dryRun(payload);
        res.json({ dryRun: true, ...result });
        return;
      }

      const result = await migrationSvc.apply(payload);
      for (const item of result.items) {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId,
          action: "secret.provider_migrated",
          entityType: "secret",
          entityId: item.secretId,
          details: {
            from: item.fromProvider,
            to: item.toProvider,
            versions: item.versionsMigrated,
          },
        });
      }
      res.json({ dryRun: false, ...result });
    },
  );

  return router;
}
