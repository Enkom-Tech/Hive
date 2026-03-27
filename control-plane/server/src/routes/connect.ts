import { Router, type Request } from "express";
import type { Db } from "@hive/db";
import { connectSchema, normalizeAgentUrlKey, ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK } from "@hive/shared";
import { validate } from "../middleware/validate.js";
import { agentService, issueService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyPermission, getActorInfo } from "./authz.js";

function getBaseUrl(req: Request, authPublicBaseUrl?: string): string {
  const fromRequest =
    req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (host) return `${fromRequest}://${host}`;
  return authPublicBaseUrl ?? "";
}

export function connectRoutes(
  db: Db,
  opts: { authPublicBaseUrl?: string } = {},
) {
  const router = Router();
  const svc = agentService(db);
  const { authPublicBaseUrl } = opts;

  router.post("/companies/:companyId/connect", validate(connectSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "company:settings");

    const { toolName, toolVersion, agentName } = req.body;
    const resolved = await svc.resolveByReference(companyId, agentName);
    let agent = resolved.agent;
    if (resolved.ambiguous) {
      const list = await svc.list(companyId);
      const urlKey = normalizeAgentUrlKey(agentName);
      const sameSlug = list.filter((a) => a.urlKey === urlKey);
      const byTool =
        toolName && sameSlug.length > 1
          ? sameSlug.filter(
              (a) =>
                a.metadata &&
                typeof a.metadata === "object" &&
                (a.metadata as Record<string, unknown>).toolName === toolName,
            )
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

    const baseUrl = getBaseUrl(req, authPublicBaseUrl);
    const heartbeatUrl = baseUrl
      ? `${baseUrl}/api/agents/${agent.id}/heartbeat/invoke`
      : "";
    const sseUrl = baseUrl ? `${baseUrl}/api/companies/${companyId}/events` : "";

    if (created) {
      await svc.createApiKey(agent.id, "connect");
    }

    const issueSvc = issueService(db);
    const tasks = await issueSvc.list(companyId, {
      assigneeAgentId: agent.id,
      status: ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK.join(","),
    });
    const workItems = { tasks };

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

    res.status(created ? 201 : 200).json({
      agentId: agent.id,
      heartbeatUrl,
      sseUrl,
      workItems,
    });
  });

  return router;
}
