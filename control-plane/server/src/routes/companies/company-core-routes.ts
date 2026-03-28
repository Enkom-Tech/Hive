import type { Router } from "express";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanySchema,
} from "@hive/shared";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import { logActivity } from "../../services/index.js";
import { assertBoard, assertCompanyPermission, assertCompanyRead, assertInstanceAdmin, getActorInfo } from "../authz.js";
import { parseWorkerProvisionManifest } from "../../services/worker-provision-manifest.js";
import type { CompanyRoutesDeps } from "./company-routes-context.js";

export function registerCompanyCoreListStatsRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, svc } = deps;

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
    const allowed =
      p?.type === "system" || p?.roles?.includes("instance_admin")
        ? null
        : new Set(p?.company_ids ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed!.has(companyId)));
    res.json(filtered);
  });
}

export function registerCompanyCoreDetailPortabilityCrudRoutes(router: Router, deps: CompanyRoutesDeps) {
  const { db, svc, portability, access } = deps;

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
}
