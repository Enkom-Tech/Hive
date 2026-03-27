import { Router } from "express";
import { z } from "zod";
import type { Db } from "@hive/db";
import { pluginManifestSchema, pluginCapabilitySchema } from "@hive/plugin-sdk";
import { validate } from "../middleware/validate.js";
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

export function pluginBoardRoutes(db: Db) {
  const router = Router();
  const svc = pluginRegistryService(db);

  router.get("/companies/:companyId/plugins", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);
      const rows = await svc.listForCompany(companyId);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.post("/companies/:companyId/plugins", validate(registerBodySchema), async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "plugins:manage");
      const body = req.body as z.infer<typeof registerBodySchema>;
      const manifestJson = JSON.stringify(body.manifest);
      const out = await svc.registerFromManifest({
        companyId,
        packageKey: body.packageKey,
        version: body.version,
        manifest: body.manifest,
        manifestJson,
        digestSha256: body.digestSha256,
      });
      if (!out) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    "/companies/:companyId/plugins/:instanceId",
    validate(patchBodySchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const instanceId = req.params.instanceId as string;
        await assertCompanyPermission(db, req, companyId, "plugins:manage");
        const body = req.body as z.infer<typeof patchBodySchema>;
        const updated = await svc.patchInstance({
          companyId,
          instanceId,
          enabled: body.enabled,
          capabilities: body.capabilities,
        });
        if (!updated) {
          res.status(404).json({ error: "Plugin instance not found" });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
