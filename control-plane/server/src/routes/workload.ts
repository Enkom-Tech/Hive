import { Router } from "express";
import type { Db } from "@hive/db";
import { workloadService } from "../services/workload.js";
import { assertCompanyRead } from "./authz.js";

export function workloadRoutes(db: Db) {
  const router = Router();
  const svc = workloadService(db);

  router.get("/companies/:companyId/workload", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const workload = await svc.getWorkload(companyId);
    res.json(workload);
  });

  return router;
}
