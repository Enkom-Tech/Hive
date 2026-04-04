import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { createWorkerPairingRequestSchema } from "@hive/shared";
import { workerPairingService } from "../services/worker-pairing.js";
import { agentService } from "../services/agents.js";

function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export async function workerPairingPublicPlugin(
  fastify: FastifyInstance,
  opts: { db: Db },
): Promise<void> {
  const agentSvc = agentService(opts.db);
  const pairing = workerPairingService(opts.db, {
    mintEnrollment: (agentId, ttl) => agentSvc.createLinkEnrollmentToken(agentId, ttl),
  });

  fastify.post("/api/worker-pairing/requests", async (req, reply) => {
    const parsed = createWorkerPairingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    }
    const { agentId, clientInfo } = parsed.data as { agentId: string; clientInfo?: Record<string, unknown> };
    const out = await pairing.createAnonymousRequest({
      agentId,
      clientInfo: clientInfo ?? null,
      requestIp: clientIp(req),
    });
    return reply.status(201).send({
      requestId: out.requestId,
      expiresAt: out.expiresAt.toISOString(),
    });
  });

  fastify.get<{ Params: { requestId: string } }>("/api/worker-pairing/requests/:requestId", async (req, reply) => {
    const { requestId } = req.params;
    const result = await pairing.pollRequest(requestId);
    if (result.status === "not_found") {
      return reply.status(404).send({ error: "Not found" });
    }
    if (result.status === "ready") {
      return reply.send({
        status: "ready",
        enrollmentToken: result.enrollmentToken,
        agentId: result.agentId,
      });
    }
    return reply.send({ status: result.status });
  });
}
