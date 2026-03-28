import { Router } from "express";
import type { Db } from "@hive/db";
import { costService, heartbeatService, issueService } from "../../services/index.js";
import { registerWorkerApiIssueWriteRoutes } from "./worker-api-issue-write-routes.js";
import { registerWorkerApiMiscRoutes } from "./worker-api-misc-routes.js";
import type { WorkerApiRoutesContext } from "./worker-api-routes-context.js";

export function workerApiRoutes(db: Db, opts: { secretsStrictMode: boolean }): Router {
  const router = Router();
  const ctx: WorkerApiRoutesContext = {
    db,
    strictSecretsMode: opts.secretsStrictMode,
    costs: costService(db),
    issues: issueService(db),
    heartbeat: heartbeatService(db),
  };
  registerWorkerApiIssueWriteRoutes(router, ctx);
  registerWorkerApiMiscRoutes(router, ctx);
  return router;
}
