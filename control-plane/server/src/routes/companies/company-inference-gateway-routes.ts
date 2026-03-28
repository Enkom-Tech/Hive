import { createHash, randomBytes } from "node:crypto";
import type { Router } from "express";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { gatewayVirtualKeys, hiveDeployments, inferenceModels, type Db } from "@hive/db";
import { createGatewayVirtualKeySchema, createInferenceModelSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { bifrostCreateVirtualKey, type BifrostProviderConfigInput } from "../../services/bifrost-admin.js";
import { registerModelTrainingRoutes } from "../model-training-routes.js";
import { assertCompanyPermission, assertCompanyRead } from "../authz.js";
import type { CompanyRoutesDeps } from "./company-routes-context.js";

async function listEffectiveChatModelsForRouter(db: Db, companyId: string, deploymentId: string) {
  const modelRows = await db
    .select()
    .from(inferenceModels)
    .where(
      and(
        eq(inferenceModels.deploymentId, deploymentId),
        eq(inferenceModels.enabled, true),
        eq(inferenceModels.kind, "chat"),
        or(isNull(inferenceModels.companyId), eq(inferenceModels.companyId, companyId)),
      ),
    );
  const bySlug = new Map<string, (typeof modelRows)[0]>();
  for (const r of modelRows) {
    if (r.companyId === companyId) {
      bySlug.set(r.modelSlug, r);
    }
  }
  for (const r of modelRows) {
    if (r.companyId == null && !bySlug.has(r.modelSlug)) {
      bySlug.set(r.modelSlug, r);
    }
  }
  return [...bySlug.values()];
}

export function registerCompanyModelTrainingRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, routeOpts } = deps;
  registerModelTrainingRoutes(router, db, {
    internalOperatorSecret: routeOpts?.internalHiveOperatorSecret,
    apiPublicBaseUrl: routeOpts?.apiPublicBaseUrl,
  });
}

export function registerCompanyInferenceCatalogRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, svc } = deps;

  router.get("/:companyId/inference-models", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);
      const company = await svc.getById(companyId);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      const rows = await db
        .select()
        .from(inferenceModels)
        .where(
          and(
            eq(inferenceModels.deploymentId, company.deploymentId),
            or(isNull(inferenceModels.companyId), eq(inferenceModels.companyId, companyId)),
          ),
        );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post(
    "/:companyId/inference-models",
    validate(createInferenceModelSchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyPermission(db, req, companyId, "company:settings");
        const company = await svc.getById(companyId);
        if (!company) {
          res.status(404).json({ error: "Company not found" });
          return;
        }
        const body = req.body as import("@hive/shared").CreateInferenceModel;
        const [row] = await db
          .insert(inferenceModels)
          .values({
            deploymentId: company.deploymentId,
            companyId: body.deploymentDefault ? null : companyId,
            modelSlug: body.modelSlug,
            kind: body.kind,
            baseUrl: body.baseUrl,
            enabled: body.enabled,
            updatedAt: new Date(),
          })
          .returning();
        res.status(201).json(row);
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/:companyId/inference-router-config", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);
      const company = await svc.getById(companyId);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      const [depRow] = await db
        .select({ modelGatewayBackend: hiveDeployments.modelGatewayBackend })
        .from(hiveDeployments)
        .where(eq(hiveDeployments.id, company.deploymentId))
        .limit(1);
      const modelGatewayBackend = depRow?.modelGatewayBackend ?? "bifrost";
      const keyKindFilter = modelGatewayBackend === "bifrost" ? "bifrost" : "hive_router";

      const effectiveModels = await listEffectiveChatModelsForRouter(db, companyId, company.deploymentId);

      const modelsJson = {
        models: effectiveModels.map((m) => ({
          id: m.modelSlug,
          base_url: m.baseUrl,
        })),
      };

      const vkRows = await db
        .select({
          sha256: gatewayVirtualKeys.keyHash,
          company_id: gatewayVirtualKeys.companyId,
        })
        .from(gatewayVirtualKeys)
        .where(
          and(
            eq(gatewayVirtualKeys.deploymentId, company.deploymentId),
            eq(gatewayVirtualKeys.keyKind, keyKindFilter),
            isNull(gatewayVirtualKeys.revokedAt),
          ),
        );

      res.json({
        modelGatewayBackend,
        models: modelsJson,
        virtualKeys: { keys: vkRows },
      });
    } catch (e) {
      next(e);
    }
  });
}

export function registerCompanyGatewayVirtualKeyRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, routeOpts, svc } = deps;

  router.post(
    "/:companyId/gateway-virtual-keys",
    validate(createGatewayVirtualKeySchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyPermission(db, req, companyId, "company:settings");
        const company = await svc.getById(companyId);
        if (!company) {
          res.status(404).json({ error: "Company not found" });
          return;
        }
        const body = req.body as import("@hive/shared").CreateGatewayVirtualKey;
        const [depRow] = await db
          .select({ modelGatewayBackend: hiveDeployments.modelGatewayBackend })
          .from(hiveDeployments)
          .where(eq(hiveDeployments.id, company.deploymentId))
          .limit(1);
        const modelGatewayBackend = depRow?.modelGatewayBackend ?? "bifrost";

        if (modelGatewayBackend === "bifrost") {
          const admin = routeOpts?.bifrostAdmin;
          if (!admin?.baseUrl?.trim() || !admin.token?.trim()) {
            res.status(503).json({
              error:
                "Bifrost governance is not configured on the server (set HIVE_BIFROST_ADMIN_BASE_URL and HIVE_BIFROST_ADMIN_TOKEN)",
            });
            return;
          }
          const effectiveModels = await listEffectiveChatModelsForRouter(db, companyId, company.deploymentId);
          const allowedModels = effectiveModels.map((m) => m.modelSlug);
          const providerConfigs: BifrostProviderConfigInput[] = [
            {
              provider: "openai",
              weight: 1,
              allowed_models: allowedModels.length > 0 ? allowedModels : undefined,
            },
          ];
          let bf: Awaited<ReturnType<typeof bifrostCreateVirtualKey>>;
          try {
            bf = await bifrostCreateVirtualKey(admin.baseUrl, admin.token, {
              name: `hive-${companyId}`,
              description: body.label ?? undefined,
              customer_id: companyId,
              provider_configs: providerConfigs,
              is_active: true,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(502).json({ error: msg });
            return;
          }
          const token = bf.value;
          const keyHash = createHash("sha256").update(token, "utf8").digest("hex");
          const keyPrefix = token.slice(0, 16);
          const [row] = await db
            .insert(gatewayVirtualKeys)
            .values({
              deploymentId: company.deploymentId,
              companyId,
              keyHash,
              keyPrefix,
              keyKind: "bifrost",
              bifrostVirtualKeyId: bf.bifrostId,
              label: body.label ?? null,
            })
            .returning();
          res.status(201).json({
            id: row.id,
            token,
            keyPrefix: row.keyPrefix,
            label: row.label,
            createdAt: row.createdAt,
            keyKind: row.keyKind,
            bifrostVirtualKeyId: row.bifrostVirtualKeyId,
          });
          return;
        }

        const token = `hive_gvk_${randomBytes(24).toString("hex")}`;
        const keyHash = createHash("sha256").update(token, "utf8").digest("hex");
        const keyPrefix = token.slice(0, 16);
        const [row] = await db
          .insert(gatewayVirtualKeys)
          .values({
            deploymentId: company.deploymentId,
            companyId,
            keyHash,
            keyPrefix,
            keyKind: "hive_router",
            label: body.label ?? null,
          })
          .returning();
        res.status(201).json({
          id: row.id,
          token,
          keyPrefix: row.keyPrefix,
          label: row.label,
          createdAt: row.createdAt,
          keyKind: row.keyKind,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/:companyId/gateway-virtual-keys", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);
      const rows = await db
        .select({
          id: gatewayVirtualKeys.id,
          keyPrefix: gatewayVirtualKeys.keyPrefix,
          keyKind: gatewayVirtualKeys.keyKind,
          bifrostVirtualKeyId: gatewayVirtualKeys.bifrostVirtualKeyId,
          label: gatewayVirtualKeys.label,
          createdAt: gatewayVirtualKeys.createdAt,
          revokedAt: gatewayVirtualKeys.revokedAt,
        })
        .from(gatewayVirtualKeys)
        .where(eq(gatewayVirtualKeys.companyId, companyId))
        .orderBy(desc(gatewayVirtualKeys.createdAt));
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/:companyId/gateway-virtual-keys/:keyId", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const keyId = req.params.keyId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const updated = await db
        .update(gatewayVirtualKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(gatewayVirtualKeys.id, keyId),
            eq(gatewayVirtualKeys.companyId, companyId),
            isNull(gatewayVirtualKeys.revokedAt),
          ),
        )
        .returning()
        .then((r) => r[0] ?? null);
      if (!updated) {
        res.status(404).json({ error: "Virtual key not found" });
        return;
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });
}
