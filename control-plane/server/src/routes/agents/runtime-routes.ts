import type { Router } from "express";
import type { Db } from "@hive/db";
import { resetAgentSessionSchema, wakeAgentSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { redactEventPayload } from "../../redaction.js";
import { logActivity } from "../../services/index.js";

export type AgentRuntimeRoutesDeps = {
  db: Db;
  svc: ReturnType<typeof import("../../services/index.js").agentService>;
  heartbeat: ReturnType<typeof import("../../services/index.js").heartbeatService>;
};

export function registerAgentRuntimeRoutes(router: Router, deps: AgentRuntimeRoutesDeps): void {
  const { db, svc, heartbeat } = deps;

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyRead(db, req, agent.companyId);
    const pWake = getCurrentPrincipal(req);
    if (pWake?.type === "agent" && pWake.id !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }
    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: pWake?.type === "agent" ? "agent" : "user",
      requestedByActorId: pWake?.type === "agent" ? pWake.id ?? null : pWake?.id ?? null,
      contextSnapshot: {
        triggeredBy: pWake?.type ?? "user",
        actorId: pWake?.type === "agent" ? pWake.id : pWake?.id,
      },
    });
    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });
    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyRead(db, req, agent.companyId);
    const pWake = getCurrentPrincipal(req);
    if (pWake?.type === "agent" && pWake.id !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }
    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: pWake?.type ?? "user",
        actorId: pWake?.type === "agent" ? pWake.id : pWake?.id,
      },
      "manual",
      {
        actorType: pWake?.type === "agent" ? "agent" : "user",
        actorId: pWake?.type === "agent" ? pWake.id ?? null : pWake?.id ?? null,
      },
    );
    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });
    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyRead(db, req, agent.companyId);
    res.status(400).json({
      error: "Agent login is not supported for managed_worker adapter.",
    });
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyRead(db, req, agent.companyId);
    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyRead(db, req, agent.companyId);
    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, agent.companyId, "runs:board");
    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: getCurrentPrincipal(req)?.id ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });
    res.json(state);
  });
}
