import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import {
  createWorkerIdentitySlotSchema,
  mintWorkerEnrollmentTokenSchema,
  patchWorkerIdentitySlotSchema,
  patchWorkerInstanceSchema,
  droneAutoDeployProfileQuerySchema,
  isDigestPinnedImageRef,
} from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { logActivity } from "../../services/index.js";
import {
  resolveEffectiveWorkerRuntimeManifest,
} from "../../services/worker-provision-manifest.js";
import { sendSignedProvisionManifestJson } from "../../services/worker-manifest-signature.js";
import { canReadCompanyWorkerRuntimeManifest } from "../../services/worker-runtime-manifest-access.js";
import { buildDroneAutoDeployProfile } from "../../services/drone-auto-deploy-profile.js";
import {
  debugWorkerLinkPoolForCompany,
  forceDisconnectWorkerInstance,
} from "../../workers/worker-link-registry.js";
import { sendDeployGrantToWorker } from "../../workers/worker-link.js";
import { assertBoard, assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import type { CompanyRoutesDeps } from "./company-routes-context.js";

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

function resolveApiPublicBaseUrl(
  req: Request,
  routeOpts: CompanyRoutesDeps["routeOpts"],
): string | null {
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

export function registerCompanyWorkerInfraEarlyRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, routeOpts, svc, agents } = deps;

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
    const apiPublicBaseUrl = resolveApiPublicBaseUrl(req, routeOpts);
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
}

export function registerCompanyWorkerInstanceManagementRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, agents } = deps;

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
}

export function registerCompanyWorkerDebugAndDeployRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, agents } = deps;

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
}

export function registerCompanyWorkerInstanceDeleteRoute(router: Router, deps: CompanyRoutesDeps) {
  const { db, agents } = deps;

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
}
