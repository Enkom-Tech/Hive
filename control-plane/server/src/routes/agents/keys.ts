import { Router } from "express";
import { createAgentKeySchema, mintWorkerEnrollmentTokenSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoard, getActorInfo } from "../authz.js";
import type { LogActivityInput } from "../../services/activity-log.js";

export type AgentKeysDeps = {
  agentService: ReturnType<typeof import("../../services/agents.js").agentService>;
  assertBoard: typeof assertBoard;
  getActorInfo: typeof getActorInfo;
  logActivity: (input: LogActivityInput) => Promise<void>;
};

export function registerAgentKeysRoutes(router: Router, deps: AgentKeysDeps): void {
  const { agentService: svc, assertBoard: assertBoardFn, getActorInfo: getActorInfoFn, logActivity: logActivityFn } = deps;

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoardFn(req);
    const id = req.params.id as string;
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoardFn(req);
    const id = req.params.id as string;
    const key = await svc.createApiKey(id, req.body.name);

    const agent = await svc.getById(id);
    if (agent) {
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
    }

    res.status(201).json(key);
  });

  router.post("/agents/:id/link-enrollment-tokens", validate(mintWorkerEnrollmentTokenSchema), async (req, res) => {
    assertBoardFn(req);
    const id = req.params.id as string;
    const { ttlSeconds } = req.body as { ttlSeconds: number };
    const { token, expiresAt } = await svc.createLinkEnrollmentToken(id, ttlSeconds);

    const agent = await svc.getById(id);
    if (agent) {
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
    }

    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoardFn(req);
    const keyId = req.params.keyId as string;
    const revoked = await svc.revokeKey(keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ok: true });
  });
}
