import type { FastifyInstance } from "fastify";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanySchema,
} from "@hive/shared";
import { logActivity } from "../../services/index.js";
import { assertBoard, assertCompanyPermission, assertCompanyRead, assertInstanceAdmin, getActorInfo } from "../authz.js";
import { parseWorkerProvisionManifest } from "../../services/worker-provision-manifest.js";
import type { CompanyRoutesDeps } from "./company-routes-context.js";

export function registerCompanyCoreListStatsRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, svc } = deps;

  fastify.get("/api/companies", async (req, reply) => {
    assertBoard(req);
    const p = req.principal ?? null;
    const result = await svc.list();
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) {
      return reply.send(result);
    }
    const allowed = new Set(p?.company_ids ?? []);
    return reply.send(result.filter((company) => allowed.has(company.id)));
  });

  fastify.get("/api/companies/stats", async (req, reply) => {
    assertBoard(req);
    const p = req.principal ?? null;
    const allowed =
      p?.type === "system" || p?.roles?.includes("instance_admin")
        ? null
        : new Set(p?.company_ids ?? []);
    const stats = await svc.stats();
    if (!allowed) return reply.send(stats);
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed!.has(companyId)));
    return reply.send(filtered);
  });
}

export function registerCompanyCoreDetailPortabilityCrudRoutesF(fastify: FastifyInstance, deps: CompanyRoutesDeps) {
  const { db, svc, portability, access } = deps;

  fastify.get("/api/companies/issues", async (_req, reply) => {
    return reply.status(400).send({ error: "Missing companyId in path. Use /api/companies/{companyId}/issues." });
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const company = await svc.getById(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    return reply.send(company);
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/export", async (req, reply) => {
    const { companyId } = req.params;
    const parsed = companyPortabilityExportSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const result = await portability.exportBundle(companyId, parsed.data);
    return reply.send(result);
  });

  fastify.post("/api/companies/import/preview", async (req, reply) => {
    const parsed = companyPortabilityPreviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    if (parsed.data.target.mode === "existing_company") {
      await assertCompanyRead(db, req, parsed.data.target.companyId);
    } else {
      assertInstanceAdmin(req);
    }
    const preview = await portability.previewImport(parsed.data);
    return reply.send(preview);
  });

  fastify.post("/api/companies/import", async (req, reply) => {
    const parsed = companyPortabilityImportSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    if (parsed.data.target.mode === "existing_company") {
      await assertCompanyPermission(db, req, parsed.data.target.companyId, "company:settings");
    } else {
      assertInstanceAdmin(req);
    }
    const actor = getActorInfo(req);
    const p = req.principal ?? null;
    const result = await portability.importBundle(parsed.data, p?.type === "user" ? p.id : null);
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
        include: parsed.data.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    return reply.send(result);
  });

  fastify.post("/api/companies", async (req, reply) => {
    assertInstanceAdmin(req);
    const parsed = createCompanySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const p = req.principal ?? null;
    const company = await svc.create(parsed.data as Parameters<typeof svc.create>[0]);
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
    return reply.status(201).send(company);
  });

  fastify.patch<{ Params: { companyId: string } }>("/api/companies/:companyId", async (req, reply) => {
    const { companyId } = req.params;
    const parsed = updateCompanySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const body = parsed.data as { workerRuntimeManifestJson?: string | null };
    const wrm = body.workerRuntimeManifestJson;
    if (wrm != null && wrm !== "") {
      try {
        parseWorkerProvisionManifest(wrm);
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    const company = await svc.update(companyId, parsed.data);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const p = req.principal ?? null;
    const activityDetails = { ...parsed.data } as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(activityDetails, "workerRuntimeManifestJson")) {
      activityDetails.workerRuntimeManifestJson =
        activityDetails.workerRuntimeManifestJson != null ? "[redacted]" : null;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: p?.id ?? "board",
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: activityDetails,
    });
    return reply.send(company);
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/archive", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const company = await svc.archive(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    const p = req.principal ?? null;
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: p?.id ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    return reply.send(company);
  });

  fastify.delete<{ Params: { companyId: string } }>("/api/companies/:companyId", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "company:settings");
    const company = await svc.remove(companyId);
    if (!company) return reply.status(404).send({ error: "Company not found" });
    return reply.send({ ok: true });
  });
}
