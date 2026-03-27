import type { NextFunction, Request, RequestHandler, Response } from "express";
import { observeWorkerApiRequest } from "../placement-metrics.js";

/** Prometheus scrape for /api/worker-api/* when HIVE_METRICS_ENABLED (see initPlacementPrometheus). */
export function workerApiMetricsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const path = req.path || "";
    const method = req.method;
    res.on("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      observeWorkerApiRequest({
        method,
        path,
        statusCode: res.statusCode,
        durationSeconds,
      });
    });
    next();
  };
}
