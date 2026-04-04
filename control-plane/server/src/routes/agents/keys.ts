import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { createAgentKeySchema, mintWorkerEnrollmentTokenSchema } from "@hive/shared";
import { assertBoard, assertCompanyPermission, getActorInfo } from "../authz.js";
import type { LogActivityInput } from "../../services/activity-log.js";

export type AgentKeysDeps = {
  db: Db;
  agentService: ReturnType<typeof import("../../services/agents.js").agentService>;
  getActorInfo: typeof getActorInfo;
  logActivity: (input: LogActivityInput) => Promise<void>;
};

export function registerAgentKeysRoutesF(fastify: FastifyInstance, deps: AgentKeysDeps): void {
  const { db, agentService: svc, getActorInfo: getActorInfoFn, logActivity: logActivityFn } = deps;

  fastify.get<{ Params: { id: string } }>("/api/agents/:id/keys", async (req, reply) => {
    assertBoard(req);
    const { id } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "secrets:manage");
    return reply.send(await svc.listKeys(id));
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/keys", async (req, reply) => {
    assertBoard(req);
    const { id } = req.params;
    const parsed = createAgentKeySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "secrets:manage");
    const key = await svc.createApiKey(id, (parsed.data as { name: string }).name);
    const actor = getActorInfoFn(req);
    await logActivityFn({
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "agent.key_created", entityType: "agent", entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });
    return reply.status(201).send(key);
  });

  fastify.post<{ Params: { id: string } }>("/api/agents/:id/link-enrollment-tokens", async (req, reply) => {
    assertBoard(req);
    const { id } = req.params;
    const parsed = mintWorkerEnrollmentTokenSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "company:settings");
    const { token, expiresAt } = await svc.createLinkEnrollmentToken(id, parsed.data.ttlSeconds);
    const actor = getActorInfoFn(req);
    await logActivityFn({
      companyId: agent.companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "agent.link_enrollment_token_created", entityType: "agent", entityId: agent.id,
      details: { ttlSeconds: parsed.data.ttlSeconds },
    });
    return reply.status(201).send({ token, expiresAt: expiresAt.toISOString() });
  });

  fastify.delete<{ Params: { id: string; keyId: string } }>("/api/agents/:id/keys/:keyId", async (req, reply) => {
    assertBoard(req);
    const { id, keyId } = req.params;
    const agent = await svc.getById(id);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    await assertCompanyPermission(db, req, agent.companyId, "secrets:manage");
    const revoked = await svc.revokeKey(keyId);
    if (!revoked) return reply.status(404).send({ error: "Key not found" });
    return reply.send({ ok: true });
  });
}
