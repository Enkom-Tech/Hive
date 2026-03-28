import type { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentApiKeys, invites, joinRequests } from "@hive/db";
import {
  claimJoinRequestApiKeySchema,
  listJoinRequestsQuerySchema,
} from "@hive/shared";
import {
  conflict,
  forbidden,
  notFound,
  badRequest,
  unprocessable,
} from "../../errors.js";
import { getCurrentPrincipal, isLocalImplicit } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import {
  agentService,
  deduplicateAgentName,
  logActivity,
  notifyHireApproved,
  secretService,
} from "../../services/index.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { assertCompanyPermission, assertCompanyRead } from "../authz.js";
import { hashToken, tokenHashesMatch } from "./helpers/tokens.js";
import {
  grantsFromDefaults,
  resolveJoinRequestAgentManagerId,
  toJoinRequestResponse,
} from "./helpers/join-shared.js";

export type JoinRoutesDeps = {
  db: Db;
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  agents: ReturnType<typeof agentService>;
  secretsSvc: ReturnType<typeof secretService>;
  joinAllowedAdapterTypes: string[] | null;
};

export function registerJoinRoutes(router: Router, deps: JoinRoutesDeps): void {
  const { db, access, agents, secretsSvc, joinAllowedAdapterTypes } = deps;

  router.get("/companies/:companyId/join-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const parsed = listJoinRequestsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    const query = parsed.data;
    const all = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .orderBy(desc(joinRequests.createdAt));
    const filtered = all.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      if (query.requestType && row.requestType !== query.requestType)
        return false;
      return true;
    });
    res.json(filtered.map(toJoinRequestResponse));
  });

  router.post(
    "/companies/:companyId/join-requests/:requestId/approve",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(db, req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.id, existing.inviteId))
        .then((rows) => rows[0] ?? null);
      if (!invite) throw notFound("Invite not found");

      let createdAgentId: string | null = existing.createdAgentId ?? null;
      if (existing.requestType === "human") {
        if (!existing.requestingUserId)
          throw conflict("Join request missing user identity");
        await access.ensureMembership(
          companyId,
          "user",
          existing.requestingUserId,
          "member",
          "active"
        );
        const grants = grantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
          "human"
        );
        await access.setPrincipalGrants(
          companyId,
          "user",
          existing.requestingUserId,
          grants,
          getCurrentPrincipal(req)?.type === "user" ? getCurrentPrincipal(req)?.id ?? null : null
        );
      } else {
        const adapterType = existing.adapterType ?? "managed_worker";
        assertAdapterTypeAllowed(adapterType);
        const joinAllowed = joinAllowedAdapterTypes;
        if (joinAllowed !== null && joinAllowed.length > 0 && !joinAllowed.includes(adapterType)) {
          throw unprocessable(
            `This adapter type is not allowed for self-join. Allowed for join: ${joinAllowed.join(", ")}`,
          );
        }

        const rawConfig =
          existing.agentDefaultsPayload &&
          typeof existing.agentDefaultsPayload === "object"
            ? (existing.agentDefaultsPayload as Record<string, unknown>)
            : {};
        const normalizedAdapterConfig =
          await secretsSvc.normalizeAdapterConfigForPersistence(companyId, rawConfig, {
            strictMode: false,
          });
        await validateAdapterConfig(adapterType, normalizedAdapterConfig, {
          companyId,
          resolveAdapterConfigForRuntime: (cid, cfg) =>
            secretsSvc.resolveAdapterConfigForRuntime(cid, cfg),
        });

        const existingAgents = await agents.list(companyId);
        const managerId = resolveJoinRequestAgentManagerId(existingAgents);
        if (!managerId) {
          throw conflict(
            "Join request cannot be approved because this company has no active CEO"
          );
        }

        const agentName = deduplicateAgentName(
          existing.agentName ?? "New Agent",
          existingAgents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status
          }))
        );

        const created = await agents.create(companyId, {
          name: agentName,
          role: "general",
          title: null,
          status: "idle",
          reportsTo: managerId,
          capabilities: existing.capabilities ?? null,
          adapterType,
          adapterConfig: normalizedAdapterConfig,
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          permissions: {},
          lastHeartbeatAt: null,
          metadata: null
        });
        createdAgentId = created.id;
        await access.ensureMembership(
          companyId,
          "agent",
          created.id,
          "member",
          "active"
        );
        const grants = grantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
          "agent"
        );
        await access.setPrincipalGrants(
          companyId,
          "agent",
          created.id,
          grants,
          getCurrentPrincipal(req)?.type === "user" ? getCurrentPrincipal(req)?.id ?? null : null
        );
      }

      const pApprove = getCurrentPrincipal(req);
      const approved = await db
        .update(joinRequests)
        .set({
          status: "approved",
          approvedByUserId:
            pApprove?.id ?? (isLocalImplicit(req) ? "local-board" : null),
          approvedAt: new Date(),
          createdAgentId,
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: pApprove?.id ?? "board",
        action: "join.approved",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType, createdAgentId }
      });

      if (createdAgentId) {
        void notifyHireApproved(db, {
          companyId,
          agentId: createdAgentId,
          source: "join_request",
          sourceId: requestId,
          approvedAt: new Date()
        }).catch(() => {});
      }

      res.json(toJoinRequestResponse(approved));
    }
  );

  router.post(
    "/companies/:companyId/join-requests/:requestId/reject",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(db, req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const pReject = getCurrentPrincipal(req);
      const rejected = await db
        .update(joinRequests)
        .set({
          status: "rejected",
          rejectedByUserId:
            pReject?.id ?? (isLocalImplicit(req) ? "local-board" : null),
          rejectedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: pReject?.id ?? "board",
        action: "join.rejected",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType }
      });

      res.json(toJoinRequestResponse(rejected));
    }
  );

  router.post(
    "/join-requests/:requestId/claim-api-key",
    validate(claimJoinRequestApiKeySchema),
    async (req, res) => {
      const requestId = req.params.requestId as string;
      const presentedClaimSecretHash = hashToken(req.body.claimSecret);
      const joinRequest = await db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, requestId))
        .then((rows) => rows[0] ?? null);
      if (!joinRequest) throw notFound("Join request not found");
      if (joinRequest.requestType !== "agent")
        throw badRequest("Only agent join requests can claim API keys");
      if (joinRequest.status !== "approved")
        throw conflict("Join request must be approved before key claim");
      if (!joinRequest.createdAgentId)
        throw conflict("Join request has no created agent");
      if (!joinRequest.claimSecretHash)
        throw conflict("Join request is missing claim secret metadata");
      if (
        !tokenHashesMatch(joinRequest.claimSecretHash, presentedClaimSecretHash)
      ) {
        throw forbidden("Invalid claim secret");
      }
      if (
        joinRequest.claimSecretExpiresAt &&
        joinRequest.claimSecretExpiresAt.getTime() <= Date.now()
      ) {
        throw conflict("Claim secret expired");
      }
      if (joinRequest.claimSecretConsumedAt)
        throw conflict("Claim secret already used");

      const existingKey = await db
        .select({ id: agentApiKeys.id })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, joinRequest.createdAgentId))
        .then((rows) => rows[0] ?? null);
      if (existingKey) throw conflict("API key already claimed");

      const consumed = await db
        .update(joinRequests)
        .set({ claimSecretConsumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(joinRequests.id, requestId),
            isNull(joinRequests.claimSecretConsumedAt)
          )
        )
        .returning({ id: joinRequests.id })
        .then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("Claim secret already used");

      const created = await agents.createApiKey(
        joinRequest.createdAgentId,
        "initial-join-key"
      );

      await logActivity(db, {
        companyId: joinRequest.companyId,
        actorType: "system",
        actorId: "join-claim",
        action: "agent_api_key.claimed",
        entityType: "agent_api_key",
        entityId: created.id,
        details: {
          agentId: joinRequest.createdAgentId,
          joinRequestId: requestId,
          credentialBinding: "worker_registration",
        },
      });

      res.status(201).json({
        keyId: created.id,
        token: created.token,
        agentId: joinRequest.createdAgentId,
        createdAt: created.createdAt,
      });
    }
  );
}
