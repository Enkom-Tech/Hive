import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { gatewayVirtualKeys, hiveDeployments, inferenceModels, type Db } from "@hive/db";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  createGatewayVirtualKeySchema,
  createInferenceModelSchema,
  createWorkerIdentitySlotSchema,
  mintWorkerEnrollmentTokenSchema,
  patchWorkerIdentitySlotSchema,
  patchWorkerInstanceSchema,
  droneAutoDeployProfileQuerySchema,
  isDigestPinnedImageRef,
  updateCompanySchema,
} from "@hive/shared";
import { getCurrentPrincipal } from "../auth/principal.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  companyPortabilityService,
  companyService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyPermission, assertCompanyRead, assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  debugWorkerLinkPoolForCompany,
  forceDisconnectWorkerInstance,
} from "../workers/worker-link-registry.js";
import { sendDeployGrantToWorker } from "../workers/worker-link.js";
import {
  parseWorkerProvisionManifest,
  resolveEffectiveWorkerRuntimeManifest,
} from "../services/worker-provision-manifest.js";
import { sendSignedProvisionManifestJson } from "../services/worker-manifest-signature.js";
import { canReadCompanyWorkerRuntimeManifest } from "../services/worker-runtime-manifest-access.js";
import { buildDroneAutoDeployProfile } from "../services/drone-auto-deploy-profile.js";
import { bifrostCreateVirtualKey, type BifrostProviderConfigInput } from "../services/bifrost-admin.js";
import { registerModelTrainingRoutes } from "./model-training-routes.js";

const mintDeployGrantSchema = z
  .object({
    agentId: z.string().uuid(),
    imageRef: z.string().min(1).max(512),
  })
  .refine((d) => isDigestPinnedImageRef(d.imageRef), {
    message:
      "imageRef must be digest-pinned: reference must end with @sha256: followed by 64 hexadecimal characters",
    path: ["imageRef"],
  });

function validateDeployGrantRequest(req: Request, res: Response, next: NextFunction) {
  const r = mintDeployGrantSchema.safeParse(req.body);
  if (!r.success) {
    const digestIssue = r.error.issues.find(
      (i) => i.path.length === 1 && i.path[0] === "imageRef" && i.code === "custom",
    );
    if (digestIssue) {
      res.status(422).json({ error: digestIssue.message });
      return;
    }
    res.status(400).json({ error: "Validation error", details: r.error.issues });
    return;
  }
  req.body = r.data;
  next();
}

async function listEffectiveChatModelsForRouter(
  db: Db,
  companyId: string,
  deploymentId: string,
) {
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

export function companyRoutes(
  db: Db,
  routeOpts?: {
    drainAutoEvacuateEnabled?: boolean;
    drainCancelInFlightPlacementsEnabled?: boolean;
    workerProvisionManifestJson?: string;
    workerProvisionManifestFile?: string;
    workerProvisionManifestSigningKeyPem?: string;
    workerIdentityAutomationEnabled?: boolean;
    /** Public API base URL for generated automation docs (e.g. https://board.example.com). */
    apiPublicBaseUrl?: string;
    bifrostAdmin?: { baseUrl: string; token: string };
    internalHiveOperatorSecret?: string;
  },
) {
  const router = Router();
  registerModelTrainingRoutes(router, db, {
    internalOperatorSecret: routeOpts?.internalHiveOperatorSecret,
    apiPublicBaseUrl: routeOpts?.apiPublicBaseUrl,
  });
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);
  const agents = agentService(db, {
    drainAutoEvacuateEnabled: routeOpts?.drainAutoEvacuateEnabled,
    drainCancelInFlightPlacementsEnabled: routeOpts?.drainCancelInFlightPlacementsEnabled,
    workerIdentityAutomationEnabled: routeOpts?.workerIdentityAutomationEnabled,
  });

  router.get("/", async (req, res) => {
    assertBoard(req);
    const p = getCurrentPrincipal(req);
    const result = await svc.list();
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) {
      res.json(result);
      return;
    }
    const allowed = new Set(p?.company_ids ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const p = getCurrentPrincipal(req);
    const allowed = p?.type === "system" || p?.roles?.includes("instance_admin")
      ? null
      : new Set(p?.company_ids ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  /** Per-company worker runtime manifest (company JSON overrides server-global manifest). */
  router.get("/:companyId/worker-runtime/manifest", async (req, res) => {
    const companyId = req.params.companyId as string;
    const allowed = await canReadCompanyWorkerRuntimeManifest(db, req, companyId);
    if (!allowed) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const company = await svc.getById(companyId);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      const manifest = await resolveEffectiveWorkerRuntimeManifest({
        companyManifestJson: company.workerRuntimeManifestJson,
        globalInlineJson: routeOpts?.workerProvisionManifestJson,
        globalFilePath: routeOpts?.workerProvisionManifestFile,
      });
      if (!manifest) {
        res.status(404).json({ error: "Provision manifest not configured" });
        return;
      }
      sendSignedProvisionManifestJson(res, manifest, routeOpts?.workerProvisionManifestSigningKeyPem, () => {
        res.setHeader("Cache-Control", "private, max-age=60");
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  function resolveApiPublicBaseUrl(req: import("express").Request): string | null {
    const configured = routeOpts?.apiPublicBaseUrl?.trim();
    if (configured) return configured.replace(/\/$/, "");
    const xfProto = req.get("x-forwarded-proto");
    const xfHost = req.get("x-forwarded-host");
    if (xfHost) {
      const proto = xfProto?.split(",")[0]?.trim() || "https";
      return `${proto}://${xfHost.split(",")[0].trim()}`;
    }
    const host = req.get("host");
    if (host) return `http://${host}`;
    return null;
  }

  router.get("/:companyId/worker-identity-slots", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const slots = await agents.listWorkerIdentitySlots(companyId);
    res.json({ slots });
  });

  router.post(
    "/:companyId/worker-identity-slots",
    validate(createWorkerIdentitySlotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const row = await agents.createWorkerIdentitySlot(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.worker_identity_slot_created",
        entityType: "company",
        entityId: companyId,
        details: { slotId: row.id, profileKey: row.profileKey, desiredCount: row.desiredCount },
      });
      res.status(201).json(row);
    },
  );

  router.patch(
    "/:companyId/worker-identity-slots/:slotId",
    validate(patchWorkerIdentitySlotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const slotId = req.params.slotId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const row = await agents.patchWorkerIdentitySlot(companyId, slotId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.worker_identity_slot_updated",
        entityType: "company",
        entityId: companyId,
        details: { slotId, patchKeys: Object.keys(req.body as object) },
      });
      res.json(row);
    },
  );

  router.delete("/:companyId/worker-identity-slots/:slotId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const slotId = req.params.slotId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    await agents.deleteWorkerIdentitySlot(companyId, slotId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.worker_identity_slot_deleted",
      entityType: "company",
      entityId: companyId,
      details: { slotId },
    });
    res.status(204).end();
  });

  router.get("/:companyId/worker-identity-automation/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    res.json(await agents.getWorkerIdentityAutomationStatus(companyId));
  });

  router.get("/:companyId/drone-auto-deploy/profile", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const parsed = droneAutoDeployProfileQuerySchema.safeParse({
      target: typeof req.query.target === "string" ? req.query.target : "docker",
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const apiPublicBaseUrl = resolveApiPublicBaseUrl(req);
    if (!apiPublicBaseUrl) {
      res.status(503).json({
        error:
          "Could not resolve public API base URL; set HIVE_AUTH_PUBLIC_BASE_URL / board public URL or rely on Host / X-Forwarded-* headers.",
      });
      return;
    }
    res.json(
      buildDroneAutoDeployProfile({
        companyId,
        target: parsed.data.target,
        apiPublicBaseUrl,
      }),
    );
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      await assertCompanyRead(db, req, req.body.target.companyId);
    } else {
      assertInstanceAdmin(req);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      await assertCompanyPermission(db, req, req.body.target.companyId, "company:settings");
    } else {
      assertInstanceAdmin(req);
    }
    const actor = getActorInfo(req);
    const pImport = getCurrentPrincipal(req);
    const result = await portability.importBundle(req.body, pImport?.type === "user" ? pImport.id : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertInstanceAdmin(req);
    const p = getCurrentPrincipal(req);
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", p?.id ?? "local-board", "admin", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: p?.id ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    res.status(201).json(company);
  });

  router.patch("/:companyId", validate(updateCompanySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const wrm = (req.body as { workerRuntimeManifestJson?: string | null }).workerRuntimeManifestJson;
    if (wrm != null && wrm !== "") {
      try {
        parseWorkerProvisionManifest(wrm);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const pUpdate = getCurrentPrincipal(req);
    const activityDetails = { ...req.body } as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(activityDetails, "workerRuntimeManifestJson")) {
      activityDetails.workerRuntimeManifestJson =
        activityDetails.workerRuntimeManifestJson != null ? "[redacted]" : null;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: pUpdate?.id ?? "board",
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: activityDetails,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const pArchive = getCurrentPrincipal(req);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: pArchive?.id ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.post(
    "/:companyId/worker-instances/:workerInstanceId/link-enrollment-tokens",
    validate(mintWorkerEnrollmentTokenSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const workerInstanceId = req.params.workerInstanceId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const { ttlSeconds } = req.body as { ttlSeconds: number };
      const { token, expiresAt } = await agents.createWorkerInstanceLinkEnrollmentToken(
        companyId,
        workerInstanceId,
        ttlSeconds,
      );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "worker_instance.link_enrollment_token_created",
        entityType: "worker_instance",
        entityId: workerInstanceId,
        details: { ttlSeconds },
      });
      res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
    },
  );

  router.post(
    "/:companyId/drone-provisioning-tokens",
    validate(mintWorkerEnrollmentTokenSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const { ttlSeconds } = req.body as { ttlSeconds: number };
      const { token, expiresAt } = await agents.createDroneProvisioningToken(companyId, ttlSeconds);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.drone_provisioning_token_created",
        entityType: "company",
        entityId: companyId,
        details: { ttlSeconds },
      });
      res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
    },
  );

  router.put(
    "/:companyId/worker-instances/:workerInstanceId/agents/:agentId",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const workerInstanceId = req.params.workerInstanceId as string;
      const agentId = req.params.agentId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      await agents.bindManagedWorkerAgentToInstance(companyId, workerInstanceId, agentId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "worker_instance.agent_bound",
        entityType: "worker_instance",
        entityId: workerInstanceId,
        details: { boundAgentId: agentId },
      });
      res.status(204).end();
    },
  );

  /** Phase B (ADR 005): advance automatic pool binding to the next eligible drone. */
  router.post("/:companyId/agents/:agentId/worker-pool/rotate", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const result = await agents.rotateAutomaticWorkerPoolPlacement(companyId, agentId);
    const actor = getActorInfo(req);
    if (result.rotated) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "worker_instance.agent_pool_rotated",
        entityType: "agent",
        entityId: agentId,
        details: {
          fromWorkerInstanceId: result.fromWorkerInstanceId,
          toWorkerInstanceId: result.toWorkerInstanceId,
        },
      });
    }
    res.json(result);
  });

  router.delete("/:companyId/worker-instances/agents/:agentId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    await agents.unbindManagedWorkerAgentFromInstance(companyId, agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worker_instance.agent_unbound",
      entityType: "agent",
      entityId: agentId,
      details: {},
    });
    res.status(204).end();
  });

  router.patch(
    "/:companyId/worker-instances/:workerInstanceId",
    validate(patchWorkerInstanceSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const workerInstanceId = req.params.workerInstanceId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const result = await agents.patchWorkerInstance(companyId, workerInstanceId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "worker_instance.updated",
        entityType: "worker_instance",
        entityId: workerInstanceId,
        details: {
          patch: req.body,
          drainEvacuation: result.drainEvacuation ?? null,
        },
      });
      res.json(result);
    },
  );

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

  router.get("/:companyId/worker-link-debug", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      res.json(debugWorkerLinkPoolForCompany(companyId));
    } catch (e) {
      next(e);
    }
  });

  router.post(
    "/:companyId/deploy-grants",
    validateDeployGrantRequest,
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyPermission(db, req, companyId, "company:settings");
        const deployOn =
          process.env.HIVE_REQUEST_DEPLOY_ENABLED === "1" ||
          process.env.HIVE_REQUEST_DEPLOY_ENABLED?.toLowerCase() === "true";
        if (!deployOn) {
          res.status(404).json({ error: "request_deploy is not enabled on this server" });
          return;
        }
        const secret = process.env.HIVE_DEPLOY_GRANT_SECRET?.trim();
        if (!secret) {
          res.status(503).json({ error: "HIVE_DEPLOY_GRANT_SECRET is not configured" });
          return;
        }
        const { agentId, imageRef } = req.body as z.infer<typeof mintDeployGrantSchema>;
        const agentRow = await agents.getById(agentId);
        if (!agentRow || agentRow.companyId !== companyId) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        const expiresAt = Date.now() + 5 * 60_000;
        const signature = createHmac("sha256", secret)
          .update(`${companyId}|${imageRef}|${expiresAt}`)
          .digest("hex");
        const delivered = sendDeployGrantToWorker(agentId, {
          type: "deploy_grant",
          companyId,
          imageRef,
          expiresAt: String(expiresAt),
          signature,
        });
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "worker.deploy_grant_minted",
          entityType: "agent",
          entityId: agentId,
          details: { imageRef, delivered, expiresAt },
        });
        res.status(201).json({ ok: true, delivered, expiresAt, imageRef });
      } catch (e) {
        next(e);
      }
    },
  );

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

  router.delete("/:companyId/worker-instances/:workerInstanceId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const workerInstanceId = req.params.workerInstanceId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    forceDisconnectWorkerInstance(workerInstanceId);
    await agents.deleteWorkerInstance(companyId, workerInstanceId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worker_instance.deleted",
      entityType: "worker_instance",
      entityId: workerInstanceId,
      details: {},
    });
    res.status(204).end();
  });

  return router;
}
