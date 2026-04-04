import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { resetAgentSessionSchema, wakeAgentSchema } from "@hive/shared";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { redactEventPayload } from "../../redaction.js";
import { logActivity } from "../../services/index.js";

export type AgentRuntimeRoutesDeps = {
  db: Db;
  svc: ReturnType<typeof import("../../services/index.js").agentService>;
  heartbeat: ReturnType<typeof import("../../services/index.js").heartbeatService>;
};

export function registerAgentRuntimeRoutesF(fastify: FastifyInstance, deps: AgentRuntimeRoutesDeps): void {
  const { db, svc, heartbeat } = deps;

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/wakeup", async (req, reply) => {
    const { id } = req.params;
    const parsed = wakeAgentSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    const p = req.principal ?? null;
    if (p?.type === "agent" && p.id !== id) return reply.status(403).send({ error: "Agent can only invoke itself" });
    const body = parsed.data as { source?: string; triggerDetail?: string; reason?: string | null; payload?: unknown; idempotencyKey?: string | null };
    const run = await heartbeat.wakeup(id, {
      source: body.source as "on_demand" | "timer" | "assignment" | "automation" | undefined,
      triggerDetail: (body.triggerDetail ?? "manual") as "manual" | "system" | "ping" | "callback" | undefined,
      reason: body.reason ?? null,
      payload: (body.payload ?? null) as Record<string, unknown> | null,
      idempotencyKey: body.idempotencyKey ?? null,
      requestedByActorType: p?.type === "agent" ? "agent" : "user",
      requestedByActorId: p?.type === "agent" ? p.id ?? null : p?.id ?? null,
      contextSnapshot: { triggeredBy: p?.type ?? "user", actorId: p?.type === "agent" ? p.id : p?.id },
    });
    if (!run) return reply.status(202).send({ status: "skipped" });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "heartbeat.invoked", entityType: "heartbeat_run", entityId: run.id,
      details: { agentId: id },
    });
    return reply.status(202).send(run);
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/heartbeat/invoke", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    const p = req.principal ?? null;
    if (p?.type === "agent" && p.id !== id) return reply.status(403).send({ error: "Agent can only invoke itself" });
    const run = await heartbeat.invoke(
      id, "on_demand",
      { triggeredBy: p?.type ?? "user", actorId: p?.type === "agent" ? p.id : p?.id },
      "manual",
      { actorType: p?.type === "agent" ? "agent" : "user", actorId: p?.type === "agent" ? p.id ?? null : p?.id ?? null },
    );
    if (!run) return reply.status(202).send({ status: "skipped" });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "heartbeat.invoked", entityType: "heartbeat_run", entityId: run.id,
      details: { agentId: id },
    });
    return reply.status(202).send(run);
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/claude-login", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    return reply.status(400).send({ error: "Agent login is not supported for managed_worker adapter." });
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/runtime-state", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    return reply.send(await heartbeat.getRuntimeState(id));
  });

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/task-sessions", async (req, reply) => {
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyRead(db, req, agent.companyId);
    const sessions = await heartbeat.listTaskSessions(id);
    return reply.send(sessions.map((session) => ({ ...session, sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null) })));
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/runtime-state/reset-session", async (req, reply) => {
    const { id } = req.params;
    const parsed = resetAgentSessionSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "runs:board");
    const body = parsed.data as { taskKey?: string };
    const taskKey = typeof body.taskKey === "string" && body.taskKey.trim().length > 0 ? body.taskKey.trim() : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });
    const p = req.principal ?? null;
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user", actorId: p?.id ?? "board",
      action: "agent.runtime_session_reset", entityType: "agent", entityId: id,
      details: { taskKey: taskKey ?? null },
    });
    return reply.send(state);
  });
}
