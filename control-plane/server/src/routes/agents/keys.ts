import { Router } from "express";
import type { Db } from "@hive/db";
import { createAgentKeySchema, mintWorkerEnrollmentTokenSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyPermission, getActorInfo } from "../authz.js";
import type { LogActivityInput } from "../../services/activity-log.js";

export type AgentKeysDeps = {
  db: Db;
  agentService: ReturnType<typeof import("../../services/agents.js").agentService>;
  getActorInfo: typeof getActorInfo;
  logActivity: (input: LogActivityInput) => Promise<void>;
};

export function registerAgentKeysRoutes(router: Router, deps: AgentKeysDeps): void {
  const { db, agentService: svc, getActorInfo: getActorInfoFn, logActivity: logActivityFn } = deps;

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, agent.companyId, "secrets:manage");
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, agent.companyId, "secrets:manage");
    const key = await svc.createApiKey(id, req.body.name);

    const actor = getActorInfoFn(req);
    await logActivityFn({
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.status(201).json(key);
  });

  router.post("/agents/:id/link-enrollment-tokens", validate(mintWorkerEnrollmentTokenSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, agent.companyId, "company:settings");
    const { ttlSeconds } = req.body as { ttlSeconds: number };
    const { token, expiresAt } = await svc.createLinkEnrollmentToken(id, ttlSeconds);

    const actor = getActorInfoFn(req);
    await logActivityFn({
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.link_enrollment_token_created",
      entityType: "agent",
      entityId: agent.id,
      details: { ttlSeconds },
    });

    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyPermission(db, req, agent.companyId, "secrets:manage");
    const keyId = req.params.keyId as string;
    const revoked = await svc.revokeKey(keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ok: true });
  });
}
