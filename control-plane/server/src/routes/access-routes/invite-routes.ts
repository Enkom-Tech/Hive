import type { Router } from "express";
import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { invites, joinRequests } from "@hive/db";
import {
  acceptInviteSchema,
  createCompanyInviteSchema,
  inviteTestResolutionQuerySchema,
} from "@hive/shared";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import {
  conflict,
  notFound,
  unauthorized,
  badRequest,
  unprocessable,
} from "../../errors.js";
import { getCurrentPrincipal, isLocalImplicit } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import { agentService, logActivity, secretService } from "../../services/index.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { assertCompanyPermission } from "../authz.js";
import {
  hashToken,
  createInviteToken,
  createClaimSecret,
  companyInviteExpiresAt,
  INVITE_TOKEN_MAX_RETRIES,
  isInviteTokenHashCollisionError,
} from "./helpers/tokens.js";
import {
  buildJoinDefaultsPayloadForAccept,
  mergeJoinDefaultsPayloadForReplay,
  normalizeAgentDefaultsForJoin,
  isPlainObject,
  type JoinDiagnostic,
} from "./helpers/join-payload.js";
import {
  buildInviteOnboardingManifest,
  buildInviteOnboardingTextDocument,
  mergeInviteDefaults,
  toInviteSummaryResponse,
} from "./helpers/onboarding.js";
import {
  inviteExpired,
  probeInviteResolutionTarget,
  requestIp,
  resolveActorEmail,
  toJoinRequestResponse,
} from "./helpers/join-shared.js";

export type InviteRoutesDeps = {
  db: Db;
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  };
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  agents: ReturnType<typeof agentService>;
  secretsSvc: ReturnType<typeof secretService>;
  joinAllowedAdapterTypes: string[] | null;
  assertInstanceAdmin: (req: Request) => Promise<void>;
};

export function registerInviteRoutes(router: Router, deps: InviteRoutesDeps): void {
  const { db, opts, access, agents, secretsSvc, joinAllowedAdapterTypes, assertInstanceAdmin } = deps;

  async function createCompanyInviteForCompany(input: {
    req: Request;
    companyId: string;
    allowedJoinTypes: "human" | "agent" | "both";
    defaultsPayload?: Record<string, unknown> | null;
    agentMessage?: string | null;
  }) {
    const normalizedAgentMessage =
      typeof input.agentMessage === "string"
        ? input.agentMessage.trim() || null
        : null;
    const insertValues = {
      companyId: input.companyId,
      inviteType: "company_join" as const,
      allowedJoinTypes: input.allowedJoinTypes,
      defaultsPayload: mergeInviteDefaults(
        input.defaultsPayload ?? null,
        normalizedAgentMessage
      ),
      expiresAt: companyInviteExpiresAt(),
      invitedByUserId: (getCurrentPrincipal(input.req)?.type === "user" ? getCurrentPrincipal(input.req)?.id : null) ?? null
    };

    let token: string | null = null;
    let created: typeof invites.$inferSelect | null = null;
    for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
      const candidateToken = createInviteToken();
      try {
        const row = await db
          .insert(invites)
          .values({
            ...insertValues,
            tokenHash: hashToken(candidateToken)
          })
          .returning()
          .then((rows) => rows[0]);
        token = candidateToken;
        created = row;
        break;
      } catch (error) {
        if (!isInviteTokenHashCollisionError(error)) {
          throw error;
        }
      }
    }
    if (!token || !created) {
      throw conflict("Failed to generate a unique invite token. Please retry.");
    }

    return { token, created, normalizedAgentMessage };
  }

  router.post(
    "/companies/:companyId/invites",
    validate(createCompanyInviteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "users:invite");
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          companyId,
          allowedJoinTypes: req.body.allowedJoinTypes,
          defaultsPayload: req.body.defaultsPayload ?? null,
          agentMessage: req.body.agentMessage ?? null
        });

      const p = getCurrentPrincipal(req);
      await logActivity(db, {
        companyId,
        actorType: p?.type === "agent" ? "agent" : "user",
        actorId:
          p?.type === "agent"
            ? p.id
            : p?.id ?? "board",
        action: "invite.created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const inviteSummary = toInviteSummaryResponse(req, token, created);
      res.status(201).json({
        ...created,
        token,
        inviteUrl: `/invite/${token}`,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.get("/invites/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (
      !invite ||
      invite.revokedAt ||
      invite.acceptedAt ||
      inviteExpired(invite)
    ) {
      throw notFound("Invite not found");
    }

    res.json(toInviteSummaryResponse(req, token, invite));
  });

  router.get("/invites/:token/onboarding", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res.json(buildInviteOnboardingManifest(req, token, invite, opts));
  });

  router.get("/invites/:token/onboarding.txt", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res
      .type("text/plain; charset=utf-8")
      .send(buildInviteOnboardingTextDocument(req, token, invite, opts));
  });

  router.get("/invites/:token/test-resolution", async (req, res) => {
    const token = (req.params.token as string).trim();
    const query = inviteTestResolutionQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query", details: query.error.issues });
      return;
    }
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const rawUrl = query.data.url.trim();
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw badRequest("url must be an absolute http(s) URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw badRequest("url must use http or https");
    }

    const timeoutMs = query.data.timeoutMs;
    const probe = await probeInviteResolutionTarget(target, timeoutMs);
    res.json({
      inviteId: invite.id,
      testResolutionPath: `/api/invites/${token}/test-resolution`,
      requestedUrl: target.toString(),
      timeoutMs,
      ...probe
    });
  });

  router.post(
    "/invites/:token/accept",
    validate(acceptInviteSchema),
    async (req, res) => {
      const token = (req.params.token as string).trim();
      if (!token) throw notFound("Invite not found");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(token)))
        .then((rows) => rows[0] ?? null);
      if (!invite || invite.revokedAt || inviteExpired(invite)) {
        throw notFound("Invite not found");
      }
      const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
      const existingJoinRequestForInvite = inviteAlreadyAccepted
        ? await db
            .select()
            .from(joinRequests)
            .where(eq(joinRequests.inviteId, invite.id))
            .then((rows) => rows[0] ?? null)
        : null;

      if (invite.inviteType === "bootstrap_ceo") {
        if (inviteAlreadyAccepted) throw notFound("Invite not found");
        if (req.body.requestType !== "human") {
          throw badRequest("Bootstrap invite requires human request type");
        }
        const p = getCurrentPrincipal(req);
        const isBoard = p?.type === "user" || p?.type === "system";
        if (
          !isBoard ||
          (!p?.id && !isLocalImplicit(req))
        ) {
          throw unauthorized(
            "Authenticated user required for bootstrap acceptance"
          );
        }
        const userId = p?.id ?? "local-board";
        const existingAdmin = await access.isInstanceAdmin(userId);
        if (!existingAdmin) {
          await access.promoteInstanceAdmin(userId);
        }
        const updatedInvite = await db
          .update(invites)
          .set({ acceptedAt: new Date(), updatedAt: new Date() })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? invite);
        res.status(202).json({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId
        });
        return;
      }

      const requestType = req.body.requestType as "human" | "agent";
      const companyId = invite.companyId;
      if (!companyId) throw conflict("Invite is missing company scope");
      if (
        invite.allowedJoinTypes !== "both" &&
        invite.allowedJoinTypes !== requestType
      ) {
        throw badRequest(`Invite does not allow ${requestType} joins`);
      }

      const pAccept = getCurrentPrincipal(req);
      const isBoardAccept = pAccept?.type === "user" || pAccept?.type === "system";
      if (requestType === "human" && !isBoardAccept) {
        throw unauthorized(
          "Human invite acceptance requires authenticated user"
        );
      }
      if (
        requestType === "human" &&
        !pAccept?.id &&
        !isLocalImplicit(req)
      ) {
        throw unauthorized("Authenticated user is required");
      }
      if (requestType === "agent" && !req.body.agentName) {
        if (
          !inviteAlreadyAccepted ||
          !existingJoinRequestForInvite?.agentName
        ) {
          throw badRequest("agentName is required for agent join requests");
        }
      }

      const adapterType = req.body.adapterType ?? null;
      if (requestType === "agent") {
        if (!adapterType || typeof adapterType !== "string" || adapterType.trim() === "") {
          throw unprocessable("adapterType is required for agent join requests");
        }
        assertAdapterTypeAllowed(adapterType);
        const joinAllowed = joinAllowedAdapterTypes;
        if (joinAllowed !== null && joinAllowed.length > 0 && !joinAllowed.includes(adapterType)) {
          throw unprocessable(
            `This adapter type is not allowed for self-join. Allowed for join: ${joinAllowed.join(", ")}`,
          );
        }
      }
      if (inviteAlreadyAccepted && !existingJoinRequestForInvite) {
        throw notFound("Invite not found");
      }
      const replayJoinRequestId = inviteAlreadyAccepted
        ? existingJoinRequestForInvite?.id ?? null
        : null;
      if (inviteAlreadyAccepted && !replayJoinRequestId) {
        throw conflict("Join request not found");
      }

      const replayMergedDefaults = inviteAlreadyAccepted
        ? mergeJoinDefaultsPayloadForReplay(
            existingJoinRequestForInvite?.agentDefaultsPayload ?? null,
            req.body.agentDefaultsPayload ?? null
          )
        : req.body.agentDefaultsPayload ?? null;

      const gatewayDefaultsPayload =
        requestType === "agent"
          ? buildJoinDefaultsPayloadForAccept({
              adapterType,
              defaultsPayload: replayMergedDefaults
            })
          : null;

      const joinDefaults =
        requestType === "agent"
          ? normalizeAgentDefaultsForJoin({
              adapterType,
              defaultsPayload: gatewayDefaultsPayload,
              deploymentMode: opts.deploymentMode,
              deploymentExposure: opts.deploymentExposure,
              bindHost: opts.bindHost,
              allowedHostnames: opts.allowedHostnames
            })
          : {
              normalized: null as Record<string, unknown> | null,
              diagnostics: [] as JoinDiagnostic[],
              fatalErrors: [] as string[]
            };

      if (requestType === "agent" && joinDefaults.fatalErrors.length > 0) {
        throw badRequest(joinDefaults.fatalErrors.join("; "));
      }

      let agentDefaultsPayloadToStore: Record<string, unknown> | null =
        requestType === "agent" ? joinDefaults.normalized : null;
      if (requestType === "agent" && adapterType) {
        const raw = isPlainObject(replayMergedDefaults)
          ? (replayMergedDefaults as Record<string, unknown>)
          : isPlainObject(req.body.agentDefaultsPayload)
            ? (req.body.agentDefaultsPayload as Record<string, unknown>)
            : {};
        agentDefaultsPayloadToStore =
          await secretsSvc.normalizeAdapterConfigForPersistence(companyId, raw, {
            strictMode: false,
          });
        await validateAdapterConfig(adapterType, agentDefaultsPayloadToStore, {
          companyId,
          resolveAdapterConfigForRuntime: (cid, cfg) =>
            secretsSvc.resolveAdapterConfigForRuntime(cid, cfg),
        });
      }

      const claimSecret =
        requestType === "agent" && !inviteAlreadyAccepted
          ? createClaimSecret()
          : null;
      const claimSecretHash = claimSecret ? hashToken(claimSecret) : null;
      const claimSecretExpiresAt = claimSecret
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;

      const actorEmail =
        requestType === "human" ? await resolveActorEmail(db, req) : null;
      const created = !inviteAlreadyAccepted
        ? await db.transaction(async (tx) => {
            await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(invites.id, invite.id),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt)
                )
              );

            const row = await tx
              .insert(joinRequests)
              .values({
                inviteId: invite.id,
                companyId,
                requestType,
                status: "pending_approval",
                requestIp: requestIp(req),
                requestingUserId:
                  requestType === "human"
                    ? (pAccept?.id ?? "local-board")
                    : null,
                requestEmailSnapshot:
                  requestType === "human" ? actorEmail : null,
                agentName: requestType === "agent" ? req.body.agentName : null,
                adapterType: requestType === "agent" ? adapterType : null,
                capabilities:
                  requestType === "agent"
                    ? req.body.capabilities ?? null
                    : null,
                agentDefaultsPayload:
                  requestType === "agent" ? agentDefaultsPayloadToStore : null,
                claimSecretHash,
                claimSecretExpiresAt
              })
              .returning()
              .then((rows) => rows[0]);
            return row;
          })
        : await db
            .update(joinRequests)
            .set({
              requestIp: requestIp(req),
              agentName:
                requestType === "agent"
                  ? req.body.agentName ??
                    existingJoinRequestForInvite?.agentName ??
                    null
                  : null,
              capabilities:
                requestType === "agent"
                  ? req.body.capabilities ??
                    existingJoinRequestForInvite?.capabilities ??
                    null
                  : null,
              adapterType: requestType === "agent" ? adapterType : null,
              agentDefaultsPayload:
                requestType === "agent" ? agentDefaultsPayloadToStore : null,
              updatedAt: new Date()
            })
            .where(eq(joinRequests.id, replayJoinRequestId as string))
            .returning()
            .then((rows) => rows[0]);

      if (!created) {
        throw conflict("Join request not found");
      }

      if (
        inviteAlreadyAccepted &&
        requestType === "agent" &&
        created.status === "approved" &&
        created.createdAgentId
      ) {
        const existingAgent = await agents.getById(created.createdAgentId);
        if (!existingAgent) {
          throw conflict("Approved join request agent not found");
        }
        const existingAdapterConfig = isPlainObject(existingAgent.adapterConfig)
          ? (existingAgent.adapterConfig as Record<string, unknown>)
          : {};
        const nextAdapterConfig = {
          ...existingAdapterConfig,
          ...(joinDefaults.normalized ?? {})
        };
        const updatedAgent = await agents.update(created.createdAgentId, {
          adapterType,
          adapterConfig: nextAdapterConfig
        });
        if (!updatedAgent) {
          throw conflict("Approved join request agent not found");
        }
        const pReplay = getCurrentPrincipal(req);
        await logActivity(db, {
          companyId,
          actorType: pReplay?.type === "agent" ? "agent" : "user",
          actorId:
            pReplay?.type === "agent"
              ? pReplay.id
              : pReplay?.id ?? "board",
          action: "agent.updated_from_join_replay",
          entityType: "agent",
          entityId: updatedAgent.id,
          details: { inviteId: invite.id, joinRequestId: created.id }
        });
      }

      const pJoin = getCurrentPrincipal(req);
      await logActivity(db, {
        companyId,
        actorType: pJoin?.type === "agent" ? "agent" : "user",
        actorId:
          pJoin?.type === "agent"
            ? pJoin.id
            : pJoin?.id ?? (requestType === "agent" ? "invite-anon" : "board"),
        action: inviteAlreadyAccepted
          ? "join.request_replayed"
          : "join.requested",
        entityType: "join_request",
        entityId: created.id,
        details: {
          requestType,
          requestIp: created.requestIp,
          inviteReplay: inviteAlreadyAccepted
        }
      });

      const response = toJoinRequestResponse(created);
      if (claimSecret) {
        const onboardingManifest = buildInviteOnboardingManifest(
          req,
          token,
          invite,
          opts
        );
        res.status(202).json({
          ...response,
          claimSecret,
          claimApiKeyPath: `/api/join-requests/${created.id}/claim-api-key`,
          onboarding: onboardingManifest.onboarding,
          diagnostics: joinDefaults.diagnostics
        });
        return;
      }
      res.status(202).json({
        ...response,
        ...(joinDefaults.diagnostics.length > 0
          ? { diagnostics: joinDefaults.diagnostics }
          : {})
      });
    }
  );

  router.post("/invites/:inviteId/revoke", async (req, res) => {
    const id = req.params.inviteId as string;
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.inviteType === "bootstrap_ceo") {
      await assertInstanceAdmin(req);
    } else {
      if (!invite.companyId) throw conflict("Invite is missing company scope");
      await assertCompanyPermission(db, req, invite.companyId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("Invite already consumed");
    if (invite.revokedAt) return res.json(invite);

    const revoked = await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, id))
      .returning()
      .then((rows) => rows[0]);

    if (invite.companyId) {
      const pRevoke = getCurrentPrincipal(req);
      await logActivity(db, {
        companyId: invite.companyId,
        actorType: pRevoke?.type === "agent" ? "agent" : "user",
        actorId:
          pRevoke?.type === "agent"
            ? pRevoke.id
            : pRevoke?.id ?? "board",
        action: "invite.revoked",
        entityType: "invite",
        entityId: id
      });
    }

    res.json(revoked);
  });
}
