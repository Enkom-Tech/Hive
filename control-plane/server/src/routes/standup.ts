import { Router } from "express";
import type { Db } from "@hive/db";
import { standupService } from "../services/standup.js";
import { assertCompanyRead } from "./authz.js";

export function standupRoutes(db: Db) {
  const router = Router();
  const svc = standupService(db);

  router.get("/companies/:companyId/standup", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const report = await svc.getReport(companyId);
    res.json(report);
  });

  return router;
}
