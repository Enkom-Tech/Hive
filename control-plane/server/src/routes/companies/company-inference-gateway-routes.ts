import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { gatewayVirtualKeys, hiveDeployments, inferenceModels, type Db } from "@hive/db";
import { createGatewayVirtualKeySchema, createInferenceModelSchema } from "@hive/shared";
import { bifrostCreateVirtualKey, type BifrostProviderConfigInput } from "../../services/bifrost-admin.js";
import { registerModelTrainingRoutesF } from "../model-training-routes.js";
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

export function registerCompanyModelTrainingRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, routeOpts } = deps;
  registerModelTrainingRoutesF(fastify, db, {
    internalOperatorSecret: routeOpts?.internalHiveOperatorSecret,
    apiPublicBaseUrl: routeOpts?.apiPublicBaseUrl,
  });
}

export function registerCompanyInferenceCatalogRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, svc } = deps;

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/inference-models", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const company = await svc.getById(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const rows = await db.select().from(inferenceModels).where(
      and(
        eq(inferenceModels.deploymentId, company.deploymentId),
        or(isNull(inferenceModels.companyId), eq(inferenceModels.companyId, companyId)),
      ),
    );
    return reply.send(rows);
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/inference-models", async (req, reply) => {
    const { companyId } = req.params;
    const parsed = createInferenceModelSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const company = await svc.getById(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const body = parsed.data as import("@hive/shared").CreateInferenceModel;
    const [row] = await db.insert(inferenceModels).values({
      deploymentId: company.deploymentId,
      companyId: body.deploymentDefault ? null : companyId,
      modelSlug: body.modelSlug,
      kind: body.kind,
      baseUrl: body.baseUrl,
      enabled: body.enabled,
      updatedAt: new Date(),
    }).returning();
    return reply.status(201).send(row);
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/inference-router-config", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const company = await svc.getById(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const [depRow] = await db.select({ modelGatewayBackend: hiveDeployments.modelGatewayBackend })
      .from(hiveDeployments).where(eq(hiveDeployments.id, company.deploymentId)).limit(1);
    const modelGatewayBackend = depRow?.modelGatewayBackend ?? "bifrost";
    const keyKindFilter = modelGatewayBackend === "bifrost" ? "bifrost" : "hive_router";
    const effectiveModels = await listEffectiveChatModelsForRouter(db, companyId, company.deploymentId);
    const modelsJson = { models: effectiveModels.map((m) => ({ id: m.modelSlug, base_url: m.baseUrl })) };
    const vkRows = await db.select({
      sha256: gatewayVirtualKeys.keyHash,
      company_id: gatewayVirtualKeys.companyId,
    }).from(gatewayVirtualKeys).where(
      and(
        eq(gatewayVirtualKeys.deploymentId, company.deploymentId),
        eq(gatewayVirtualKeys.keyKind, keyKindFilter),
        isNull(gatewayVirtualKeys.revokedAt),
      ),
    );
    return reply.send({ modelGatewayBackend, models: modelsJson, virtualKeys: { keys: vkRows } });
  });
}

export function registerCompanyGatewayVirtualKeyRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, routeOpts, svc } = deps;

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/gateway-virtual-keys", async (req, reply) => {
    const { companyId } = req.params;
    const parsed = createGatewayVirtualKeySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const company = await svc.getById(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const body = parsed.data as import("@hive/shared").CreateGatewayVirtualKey;
    const [depRow] = await db.select({ modelGatewayBackend: hiveDeployments.modelGatewayBackend })
      .from(hiveDeployments).where(eq(hiveDeployments.id, company.deploymentId)).limit(1);
    const modelGatewayBackend = depRow?.modelGatewayBackend ?? "bifrost";

    if (modelGatewayBackend === "bifrost") {
      const admin = routeOpts?.bifrostAdmin;
      if (!admin?.baseUrl?.trim() || !admin.token?.trim()) {
        return reply.status(503).send({ error: "Bifrost governance is not configured on the server (set HIVE_BIFROST_ADMIN_BASE_URL and HIVE_BIFROST_ADMIN_TOKEN)" });
      }
      const effectiveModels = await listEffectiveChatModelsForRouter(db, companyId, company.deploymentId);
      const allowedModels = effectiveModels.map((m) => m.modelSlug);
      const providerConfigs: BifrostProviderConfigInput[] = [{ provider: "openai", weight: 1, allowed_models: allowedModels.length > 0 ? allowedModels : undefined }];
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
        return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
      const token = bf.value;
      const keyHash = createHash("sha256").update(token, "utf8").digest("hex");
      const keyPrefix = token.slice(0, 16);
      const [row] = await db.insert(gatewayVirtualKeys).values({
        deploymentId: company.deploymentId, companyId, keyHash, keyPrefix, keyKind: "bifrost",
        bifrostVirtualKeyId: bf.bifrostId, label: body.label ?? null,
      }).returning();
      return reply.status(201).send({ id: row.id, token, keyPrefix: row.keyPrefix, label: row.label, createdAt: row.createdAt, keyKind: row.keyKind, bifrostVirtualKeyId: row.bifrostVirtualKeyId });
    }

    const token = `hive_gvk_${randomBytes(24).toString("hex")}`;
    const keyHash = createHash("sha256").update(token, "utf8").digest("hex");
    const keyPrefix = token.slice(0, 16);
    const [row] = await db.insert(gatewayVirtualKeys).values({
      deploymentId: company.deploymentId, companyId, keyHash, keyPrefix, keyKind: "hive_router", label: body.label ?? null,
    }).returning();
    return reply.status(201).send({ id: row.id, token, keyPrefix: row.keyPrefix, label: row.label, createdAt: row.createdAt, keyKind: row.keyKind });
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/gateway-virtual-keys", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const rows = await db.select({
      id: gatewayVirtualKeys.id, keyPrefix: gatewayVirtualKeys.keyPrefix, keyKind: gatewayVirtualKeys.keyKind,
      bifrostVirtualKeyId: gatewayVirtualKeys.bifrostVirtualKeyId, label: gatewayVirtualKeys.label,
      createdAt: gatewayVirtualKeys.createdAt, revokedAt: gatewayVirtualKeys.revokedAt,
    }).from(gatewayVirtualKeys).where(eq(gatewayVirtualKeys.companyId, companyId)).orderBy(desc(gatewayVirtualKeys.createdAt));
    return reply.send(rows);
  });

  fastify.delete<{ Params: { companyId: string; keyId: string } }>("/api/companies/:companyId/gateway-virtual-keys/:keyId", async (req, reply) => {
    const { companyId, keyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const updated = await db.update(gatewayVirtualKeys).set({ revokedAt: new Date() }).where(
      and(eq(gatewayVirtualKeys.id, keyId), eq(gatewayVirtualKeys.companyId, companyId), isNull(gatewayVirtualKeys.revokedAt)),
    ).returning().then((r) => r[0] ?? null);
    if (!updated) return reply.status(404).send({ error: "Virtual key not found" });
    return reply.status(204).send();
  });
}
