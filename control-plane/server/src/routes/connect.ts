import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "@hive/db";
import { connectSchema, normalizeAgentUrlKey, ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK } from "@hive/shared";
import { agentService, issueService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyPermission, getActorInfo } from "./authz.js";

function getBaseUrlFastify(req: FastifyRequest, authPublicBaseUrl?: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.protocol
    ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.headers.host;
  if (host) return `${proto}://${host}`;
  return authPublicBaseUrl ?? "";
}

export async function connectPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; authPublicBaseUrl?: string },
): Promise<void> {
  const { db, authPublicBaseUrl } = opts;
  const svc = agentService(db);

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/connect",
    async (req, reply) => {
      assertBoard(req);
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "company:settings");
      const parsed = connectSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const { toolName, toolVersion, agentName } = parsed.data;

      const resolved = await svc.resolveByReference(companyId, agentName);
      let agent = resolved.agent;
      if (resolved.ambiguous) {
        const list = await svc.list(companyId);
        const urlKey = normalizeAgentUrlKey(agentName);
        const sameSlug = list.filter((a) => a.urlKey === urlKey);
        const byTool =
          toolName && sameSlug.length > 1
            ? sameSlug.filter((a) => a.metadata && typeof a.metadata === "object" && (a.metadata as Record<string, unknown>).toolName === toolName)
            : sameSlug;
        if (byTool.length === 1) agent = byTool[0] ?? null;
      }
      const created = !agent;
      if (!agent) {
        agent = await svc.create(companyId, {
          name: agentName,
          role: "general",
          adapterType: "managed_worker",
          adapterConfig: {},
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
          metadata: { toolName, toolVersion: toolVersion ?? undefined },
        });
      }

      const baseUrl = getBaseUrlFastify(req, authPublicBaseUrl);
      const heartbeatUrl = baseUrl ? `${baseUrl}/api/agents/${agent.id}/heartbeat/invoke` : "";
      const sseUrl = baseUrl ? `${baseUrl}/api/companies/${companyId}/events` : "";

      if (created) await svc.createApiKey(agent.id, "connect");

      const issueSvc = issueService(db);
      const tasks = await issueSvc.list(companyId, {
        assigneeAgentId: agent.id,
        status: ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK.join(","),
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: created ? "agent.created" : "connect.registered",
        entityType: "agent",
        entityId: agent.id,
        details: created ? { name: agent.name, role: agent.role } : { agentName, toolName },
      });

      return reply.status(created ? 201 : 200).send({
        agentId: agent.id,
        heartbeatUrl,
        sseUrl,
        workItems: { tasks },
      });
    },
  );
}
