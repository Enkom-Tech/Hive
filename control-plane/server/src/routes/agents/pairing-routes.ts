import type { Router } from "express";
import type { Db } from "@hive/db";
import { openWorkerPairingWindowSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import type { agentService } from "../../services/agents.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import { getActorInfo, assertCompanyPermission, assertCompanyRead } from "../authz.js";
import type { workerPairingService } from "../../services/worker-pairing.js";

type AgentSvc = ReturnType<typeof agentService>;
type PairingSvc = ReturnType<typeof workerPairingService>;
type LogActivityBound = (input: LogActivityInput) => Promise<void>;

export function registerAgentWorkerPairingRoutes(
  router: Router,
  deps: {
    db: Db;
    agentService: AgentSvc;
    pairingSvc: PairingSvc;
    logActivityBound: LogActivityBound;
  },
): void {
  const { db, agentService: svc, pairingSvc, logActivityBound } = deps;

  router.post(
    "/agents/:id/worker-pairing-window",
    validate(openWorkerPairingWindowSchema),
    async (req, res, next) => {
      try {
        const id = req.params.id as string;
        const agent = await svc.getById(id);
        if (!agent) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        await assertCompanyPermission(db, req, agent.companyId, "company:settings");
        const { ttlSeconds } = req.body as { ttlSeconds: number };
        const { expiresAt } = await pairingSvc.openPairingWindow(id, ttlSeconds);
        const actor = getActorInfo(req);
        await logActivityBound({
          companyId: agent.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "agent.worker_pairing_window_opened",
          entityType: "agent",
          entityId: agent.id,
          details: { expiresAt: expiresAt.toISOString() },
        });
        res.json({ expiresAt: expiresAt.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/companies/:companyId/worker-pairing-requests", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);
      const requests = await pairingSvc.listPendingForCompany(companyId);
      res.json({ requests });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agents/:id/worker-pairing-requests/:requestId/approve", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const requestId = req.params.requestId as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCompanyPermission(db, req, agent.companyId, "company:settings");
      const actor = getActorInfo(req);
      await pairingSvc.approveRequest({
        companyId: agent.companyId,
        agentId: agent.id,
        requestId,
        approvedByUserId: actor.actorId,
      });
      await logActivityBound({
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.worker_pairing_approved",
        entityType: "agent",
        entityId: agent.id,
        details: { requestId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agents/:id/worker-pairing-requests/:requestId/reject", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const requestId = req.params.requestId as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCompanyPermission(db, req, agent.companyId, "company:settings");
      const actor = getActorInfo(req);
      await pairingSvc.rejectRequest({
        companyId: agent.companyId,
        agentId: agent.id,
        requestId,
        rejectedByUserId: actor.actorId,
      });
      await logActivityBound({
        companyId: agent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.worker_pairing_rejected",
        entityType: "agent",
        entityId: agent.id,
        details: { requestId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
