import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { costService, heartbeatService, issueService } from "../../services/index.js";
import { registerWorkerApiIssueWriteRoutesFastify } from "./worker-api-issue-write-routes.js";
import { registerWorkerApiMiscRoutesFastify } from "./worker-api-misc-routes.js";
import type { WorkerApiRoutesContext } from "./worker-api-routes-context.js";
import { observeWorkerApiRequest } from "../../placement-metrics.js";

export async function workerApiPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; secretsStrictMode: boolean },
): Promise<void> {
  const ctx: WorkerApiRoutesContext = {
    db: opts.db,
    strictSecretsMode: opts.secretsStrictMode,
    costs: costService(opts.db),
    issues: issueService(opts.db),
    heartbeat: heartbeatService(opts.db),
  };

  const routePrefix = fastify.prefix ?? "";
  fastify.addHook("onResponse", async (req, reply) => {
    const durationSeconds = reply.elapsedTime / 1000;
    const fullPath = req.routeOptions?.url ?? req.url;
    const relativePath = routePrefix && fullPath.startsWith(routePrefix)
      ? fullPath.slice(routePrefix.length) || "/"
      : fullPath;
    observeWorkerApiRequest({
      method: req.method,
      path: relativePath,
      statusCode: reply.statusCode,
      durationSeconds,
    });
  });

  registerWorkerApiIssueWriteRoutesFastify(fastify, ctx);
  registerWorkerApiMiscRoutesFastify(fastify, ctx);
}
