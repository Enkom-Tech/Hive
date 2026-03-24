import { Router, type Request } from "express";
import { createWorkerPairingRequestSchema } from "@hive/shared";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../errors.js";
import type { workerPairingService as WorkerPairingServiceFn } from "../services/worker-pairing.js";

function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function workerPairingPublicRoutes(pairing: ReturnType<typeof WorkerPairingServiceFn>) {
  const router = Router();

  router.post("/worker-pairing/requests", validate(createWorkerPairingRequestSchema), async (req, res) => {
    try {
      const { agentId, clientInfo } = req.body as {
        agentId: string;
        clientInfo?: Record<string, unknown>;
      };
      const out = await pairing.createAnonymousRequest({
        agentId,
        clientInfo: clientInfo ?? null,
        requestIp: clientIp(req),
      });
      res.status(201).json({
        requestId: out.requestId,
        expiresAt: out.expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/worker-pairing/requests/:requestId", async (req, res) => {
    const requestId = req.params.requestId as string;
    try {
      const result = await pairing.pollRequest(requestId);
      if (result.status === "not_found") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (result.status === "ready") {
        res.json({
          status: "ready",
          enrollmentToken: result.enrollmentToken,
          agentId: result.agentId,
        });
        return;
      }
      res.json({ status: result.status });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
