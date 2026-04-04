import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { openWorkerPairingWindowSchema } from "@hive/shared";
import type { agentService } from "../../services/agents.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import { getActorInfo, assertCompanyPermission, assertCompanyRead } from "../authz.js";
import type { workerPairingService } from "../../services/worker-pairing.js";

type AgentSvc = ReturnType<typeof agentService>;
type PairingSvc = ReturnType<typeof workerPairingService>;
type LogActivityBound = (input: LogActivityInput) => Promise<void>;

export function registerAgentWorkerPairingRoutesF(
  fastify: FastifyInstance,
  deps: { db: Db; agentService: AgentSvc; pairingSvc: PairingSvc; logActivityBound: LogActivityBound },
): void {
  const { db, agentService: svc, pairingSvc, logActivityBound } = deps;

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/worker-pairing-window", async (req, reply) => {
    const { id } = req.params;
    const parsed = openWorkerPairingWindowSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "company:settings");
    const { expiresAt } = await pairingSvc.openPairingWindow(id, (parsed.data as { ttlSeconds: number }).ttlSeconds);
    const actor = getActorInfo(req);
    await logActivityBound({
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "agent.worker_pairing_window_opened", entityType: "agent", entityId: agent.id,
      details: { expiresAt: expiresAt.toISOString() },
    });
    return reply.send({ expiresAt: expiresAt.toISOString() });
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/worker-pairing-requests", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    return reply.send({ requests: await pairingSvc.listPendingForCompany(companyId) });
  });

  fastify.post<{ Params: { id: string; requestId: string } }>("/api/agents/:id/worker-pairing-requests/:requestId/approve", async (req, reply) => {
    const { id, requestId } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "company:settings");
    const actor = getActorInfo(req);
    await pairingSvc.approveRequest({ companyId: agent.companyId, agentId: agent.id, requestId, approvedByUserId: actor.actorId });
    await logActivityBound({
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "agent.worker_pairing_approved", entityType: "agent", entityId: agent.id,
      details: { requestId },
    });
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string; requestId: string } }>("/api/agents/:id/worker-pairing-requests/:requestId/reject", async (req, reply) => {
    const { id, requestId } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "company:settings");
    const actor = getActorInfo(req);
    await pairingSvc.rejectRequest({ companyId: agent.companyId, agentId: agent.id, requestId, rejectedByUserId: actor.actorId });
    await logActivityBound({
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "agent.worker_pairing_rejected", entityType: "agent", entityId: agent.id,
      details: { requestId },
    });
    return reply.send({ ok: true });
  });
}
