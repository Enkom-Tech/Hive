import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createWorkerIdentitySlotSchema,
  mintWorkerEnrollmentTokenSchema,
  patchWorkerIdentitySlotSchema,
  patchWorkerInstanceSchema,
  droneAutoDeployProfileQuerySchema,
  isDigestPinnedImageRef,
} from "@hive/shared";
import { logActivity } from "../../services/index.js";
import {
  resolveEffectiveWorkerRuntimeManifest,
} from "../../services/worker-provision-manifest.js";
import { sendSignedProvisionManifestJsonRaw } from "../../services/worker-manifest-signature.js";
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

function resolveApiPublicBaseUrlF(
  req: FastifyRequest,
  routeOpts: CompanyRoutesDeps["routeOpts"],
): string | null {
  const configured = routeOpts?.apiPublicBaseUrl?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const xfProto = req.headers["x-forwarded-proto"] as string | undefined;
  const xfHost = req.headers["x-forwarded-host"] as string | undefined;
  if (xfHost) {
    const proto = xfProto?.split(",")[0]?.trim() || "https";
    return `${proto}://${xfHost.split(",")[0].trim()}`;
  }
  const host = req.headers.host;
  if (host) return `http://${host}`;
  return null;
}

export function registerCompanyWorkerInfraEarlyRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, routeOpts, svc, agents } = deps;

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/worker-runtime/manifest", async (req, reply) => {
    const { companyId } = req.params;
    const allowed = await canReadCompanyWorkerRuntimeManifest(db, req, companyId);
    if (!allowed) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const company = await svc.getById(companyId);
      if (!company) return reply.status(404).send({ error: "Company not found" });
      const manifest = await resolveEffectiveWorkerRuntimeManifest({
        companyManifestJson: company.workerRuntimeManifestJson,
        globalInlineJson: routeOpts?.workerProvisionManifestJson,
        globalFilePath: routeOpts?.workerProvisionManifestFile,
      });
      if (!manifest) return reply.status(404).send({ error: "Provision manifest not configured" });
      sendSignedProvisionManifestJsonRaw(reply.raw, manifest, routeOpts?.workerProvisionManifestSigningKeyPem, () => {
        reply.raw.setHeader("Cache-Control", "private, max-age=60");
      });
      reply.hijack();
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/worker-identity-slots", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    return reply.send({ slots: await agents.listWorkerIdentitySlots(companyId) });
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/worker-identity-slots", async (req, reply) => {
    const { companyId } = req.params;
    const parsed = createWorkerIdentitySlotSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const row = await agents.createWorkerIdentitySlot(companyId, parsed.data);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "company.worker_identity_slot_created",
      entityType: "company", entityId: companyId,
      details: { slotId: row.id, profileKey: row.profileKey, desiredCount: row.desiredCount },
    });
    return reply.status(201).send(row);
  });

  fastify.patch<{ Params: { companyId: string; slotId: string } }>("/api/companies/:companyId/worker-identity-slots/:slotId", async (req, reply) => {
    const { companyId, slotId } = req.params;
    const parsed = patchWorkerIdentitySlotSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const row = await agents.patchWorkerIdentitySlot(companyId, slotId, parsed.data);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "company.worker_identity_slot_updated",
      entityType: "company", entityId: companyId,
      details: { slotId, patchKeys: Object.keys(parsed.data as object) },
    });
    return reply.send(row);
  });

  fastify.delete<{ Params: { companyId: string; slotId: string } }>("/api/companies/:companyId/worker-identity-slots/:slotId", async (req, reply) => {
    const { companyId, slotId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    await agents.deleteWorkerIdentitySlot(companyId, slotId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "company.worker_identity_slot_deleted",
      entityType: "company", entityId: companyId,
      details: { slotId },
    });
    return reply.status(204).send();
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/worker-identity-automation/status", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    return reply.send(await agents.getWorkerIdentityAutomationStatus(companyId));
  });

  fastify.get<{ Params: { companyId: string }; Querystring: { target?: string } }>("/api/companies/:companyId/drone-auto-deploy/profile", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const parsed = droneAutoDeployProfileQuerySchema.safeParse({
      target: typeof req.query.target === "string" ? req.query.target : "docker",
    });
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const apiPublicBaseUrl = resolveApiPublicBaseUrlF(req, routeOpts);
    if (!apiPublicBaseUrl) {
      return reply.status(503).send({ error: "Could not resolve public API base URL; set HIVE_AUTH_PUBLIC_BASE_URL / board public URL or rely on Host / X-Forwarded-* headers." });
    }
    return reply.send(buildDroneAutoDeployProfile({ companyId, target: parsed.data.target, apiPublicBaseUrl }));
  });
}

export function registerCompanyWorkerInstanceManagementRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, agents } = deps;

  fastify.post<{ Params: { companyId: string; workerInstanceId: string } }>("/api/companies/:companyId/worker-instances/:workerInstanceId/link-enrollment-tokens", async (req, reply) => {
    assertBoard(req);
    const { companyId, workerInstanceId } = req.params;
    const parsed = mintWorkerEnrollmentTokenSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const { token, expiresAt } = await agents.createWorkerInstanceLinkEnrollmentToken(companyId, workerInstanceId, parsed.data.ttlSeconds);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "worker_instance.link_enrollment_token_created",
      entityType: "worker_instance", entityId: workerInstanceId,
      details: { ttlSeconds: parsed.data.ttlSeconds },
    });
    return reply.status(201).send({ token, expiresAt: expiresAt.toISOString() });
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/drone-provisioning-tokens", async (req, reply) => {
    assertBoard(req);
    const { companyId } = req.params;
    const parsed = mintWorkerEnrollmentTokenSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const { token, expiresAt } = await agents.createDroneProvisioningToken(companyId, parsed.data.ttlSeconds);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "company.drone_provisioning_token_created",
      entityType: "company", entityId: companyId,
      details: { ttlSeconds: parsed.data.ttlSeconds },
    });
    return reply.status(201).send({ token, expiresAt: expiresAt.toISOString() });
  });

  fastify.put<{ Params: { companyId: string; workerInstanceId: string; agentId: string } }>("/api/companies/:companyId/worker-instances/:workerInstanceId/agents/:agentId", async (req, reply) => {
    assertBoard(req);
    const { companyId, workerInstanceId, agentId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    await agents.bindManagedWorkerAgentToInstance(companyId, workerInstanceId, agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "worker_instance.agent_bound",
      entityType: "worker_instance", entityId: workerInstanceId,
      details: { boundAgentId: agentId },
    });
    return reply.status(204).send();
  });

  fastify.post<{ Params: { companyId: string; agentId: string } }>("/api/companies/:companyId/agents/:agentId/worker-pool/rotate", async (req, reply) => {
    assertBoard(req);
    const { companyId, agentId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const result = await agents.rotateAutomaticWorkerPoolPlacement(companyId, agentId);
    const actor = getActorInfo(req);
    if (result.rotated) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType, actorId: actor.actorId,
        agentId: actor.agentId, runId: actor.runId,
        action: "worker_instance.agent_pool_rotated",
        entityType: "agent", entityId: agentId,
        details: { fromWorkerInstanceId: result.fromWorkerInstanceId, toWorkerInstanceId: result.toWorkerInstanceId },
      });
    }
    return reply.send(result);
  });

  fastify.delete<{ Params: { companyId: string; agentId: string } }>("/api/companies/:companyId/worker-instances/agents/:agentId", async (req, reply) => {
    assertBoard(req);
    const { companyId, agentId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    await agents.unbindManagedWorkerAgentFromInstance(companyId, agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "worker_instance.agent_unbound",
      entityType: "agent", entityId: agentId,
      details: {},
    });
    return reply.status(204).send();
  });

  fastify.patch<{ Params: { companyId: string; workerInstanceId: string } }>("/api/companies/:companyId/worker-instances/:workerInstanceId", async (req, reply) => {
    assertBoard(req);
    const { companyId, workerInstanceId } = req.params;
    const parsed = patchWorkerInstanceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const result = await agents.patchWorkerInstance(companyId, workerInstanceId, parsed.data);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "worker_instance.updated",
      entityType: "worker_instance", entityId: workerInstanceId,
      details: { patch: parsed.data, drainEvacuation: result.drainEvacuation ?? null },
    });
    return reply.send(result);
  });
}

export function registerCompanyWorkerDebugAndDeployRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, agents } = deps;

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/worker-link-debug", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    return reply.send(debugWorkerLinkPoolForCompany(companyId));
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/deploy-grants", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const deployOn =
      process.env.HIVE_REQUEST_DEPLOY_ENABLED === "1" ||
      process.env.HIVE_REQUEST_DEPLOY_ENABLED?.toLowerCase() === "true";
    if (!deployOn) return reply.status(404).send({ error: "request_deploy is not enabled on this server" });
    const secret = process.env.HIVE_DEPLOY_GRANT_SECRET?.trim();
    if (!secret) return reply.status(503).send({ error: "HIVE_DEPLOY_GRANT_SECRET is not configured" });

    const r = mintDeployGrantSchema.safeParse(req.body);
    if (!r.success) {
      const digestIssue = r.error.issues.find((i) => i.path.length === 1 && i.path[0] === "imageRef" && i.code === "custom");
      if (digestIssue) return reply.status(422).send({ error: digestIssue.message });
      return reply.status(400).send({ error: "Validation error", details: r.error.issues });
    }

    const { agentId, imageRef } = r.data;
    const agentRow = await agents.getById(agentId);
    if (!agentRow || agentRow.companyId !== companyId) return reply.status(404).send({ error: "Agent not found" });
    const expiresAt = Date.now() + 5 * 60_000;
    const signature = createHmac("sha256", secret).update(`${companyId}|${imageRef}|${expiresAt}`).digest("hex");
    const delivered = sendDeployGrantToWorker(agentId, {
      type: "deploy_grant", companyId, imageRef,
      expiresAt: String(expiresAt), signature,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      action: "worker.deploy_grant_minted",
      entityType: "agent", entityId: agentId,
      details: { imageRef, delivered, expiresAt },
    });
    return reply.status(201).send({ ok: true, delivered, expiresAt, imageRef });
  });
}

export function registerCompanyWorkerInstanceDeleteRouteF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, agents } = deps;

  fastify.delete<{ Params: { companyId: string; workerInstanceId: string } }>("/api/companies/:companyId/worker-instances/:workerInstanceId", async (req, reply) => {
    assertBoard(req);
    const { companyId, workerInstanceId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    forceDisconnectWorkerInstance(workerInstanceId);
    await agents.deleteWorkerInstance(companyId, workerInstanceId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "worker_instance.deleted",
      entityType: "worker_instance", entityId: workerInstanceId,
      details: {},
    });
    return reply.status(204).send();
  });
}
