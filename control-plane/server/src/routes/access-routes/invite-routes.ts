import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { authAccounts, authUsers, instanceUserRoles, invites, joinRequests } from "@hive/db";
import {
  acceptInviteSchema,
  createCompanyInviteSchema,
  inviteTestResolutionQuerySchema,
} from "@hive/shared";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import { LOCAL_BOARD_USER_ID } from "../../board-claim.js";
import {
  conflict,
  notFound,
  unauthorized,
  badRequest,
  unprocessable,
} from "../../errors.js";
import { agentService, logActivity, secretService } from "../../services/index.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { assertCompanyPermission, type PrincipalCarrier } from "../authz.js";
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
  isLocalImplicitF,
  probeInviteResolutionTarget,
  requestIpF,
  resolveActorEmailF,
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
  assertInstanceAdmin: (req: PrincipalCarrier) => Promise<void>;
};

export function registerInviteRoutesF(fastify: FastifyInstance, deps: InviteRoutesDeps): void {
  const { db, opts, access, agents, secretsSvc, joinAllowedAdapterTypes } = deps;

  async function assertInstanceAdminF(req: PrincipalCarrier): Promise<void> {
    const p = req.principal ?? null;
    if (p?.type !== "user" && p?.type !== "system") throw unauthorized();
    if (p?.type === "system") return;
    if (p?.roles?.includes("instance_admin")) return;
    const allowed = await access.isInstanceAdmin(p?.id ?? "");
    if (!allowed) throw import("../../errors.js").then(m => m.forbidden("Instance admin required"));
  }

  async function createCompanyInviteForCompanyF(input: {
    req: PrincipalCarrier;
    companyId: string;
    allowedJoinTypes: "human" | "agent" | "both";
    defaultsPayload?: Record<string, unknown> | null;
    agentMessage?: string | null;
  }) {
    const normalizedAgentMessage = typeof input.agentMessage === "string" ? input.agentMessage.trim() || null : null;
    const p = input.req.principal ?? null;
    const insertValues = {
      companyId: input.companyId,
      inviteType: "company_join" as const,
      allowedJoinTypes: input.allowedJoinTypes,
      defaultsPayload: mergeInviteDefaults(input.defaultsPayload ?? null, normalizedAgentMessage),
      expiresAt: companyInviteExpiresAt(),
      invitedByUserId: (p?.type === "user" ? p.id : null) ?? null,
    };
    let token: string | null = null;
    let created: typeof invites.$inferSelect | null = null;
    for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
      const candidateToken = createInviteToken();
      try {
        const row = await db.insert(invites).values({ ...insertValues, tokenHash: hashToken(candidateToken) }).returning().then((rows) => rows[0]);
        token = candidateToken;
        created = row;
        break;
      } catch (error) {
        if (!isInviteTokenHashCollisionError(error)) throw error;
      }
    }
    if (!token || !created) throw conflict("Failed to generate a unique invite token. Please retry.");
    return { token, created, normalizedAgentMessage };
  }

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/invites", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "users:invite");
    const parsed = createCompanyInviteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as { allowedJoinTypes: "human" | "agent" | "both"; defaultsPayload?: Record<string, unknown> | null; agentMessage?: string | null };
    const { token, created, normalizedAgentMessage } = await createCompanyInviteForCompanyF({ req, companyId, allowedJoinTypes: body.allowedJoinTypes, defaultsPayload: body.defaultsPayload ?? null, agentMessage: body.agentMessage ?? null });
    const p = req.principal ?? null;
    await logActivity(db, { companyId, actorType: p?.type === "agent" ? "agent" : "user", actorId: p?.type === "agent" ? p.id : p?.id ?? "board", action: "invite.created", entityType: "invite", entityId: created.id, details: { inviteType: created.inviteType, allowedJoinTypes: created.allowedJoinTypes, expiresAt: created.expiresAt.toISOString(), hasAgentMessage: Boolean(normalizedAgentMessage) } });
    const inviteSummary = toInviteSummaryResponse(req, token, created);
    return reply.status(201).send({ ...created, token, inviteUrl: `/invite/${token}`, onboardingTextPath: inviteSummary.onboardingTextPath, onboardingTextUrl: inviteSummary.onboardingTextUrl, inviteMessage: inviteSummary.inviteMessage });
  });

  fastify.get<{ Params: { token: string } }>("/api/invites/:token", async (req, reply) => {
    const token = req.params.token.trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || invite.acceptedAt || inviteExpired(invite)) throw notFound("Invite not found");
    return reply.send(toInviteSummaryResponse(req, token, invite));
  });

  fastify.get<{ Params: { token: string } }>("/api/invites/:token/onboarding", async (req, reply) => {
    const token = req.params.token.trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) throw notFound("Invite not found");
    return reply.send(buildInviteOnboardingManifest(req, token, invite, opts));
  });

  fastify.get<{ Params: { token: string } }>("/api/invites/:token/onboarding.txt", async (req, reply) => {
    const token = req.params.token.trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) throw notFound("Invite not found");
    return reply.type("text/plain; charset=utf-8").send(buildInviteOnboardingTextDocument(req, token, invite, opts));
  });

  fastify.get<{ Params: { token: string } }>("/api/invites/:token/test-resolution", async (req, reply) => {
    const token = req.params.token.trim();
    const query = inviteTestResolutionQuerySchema.safeParse(req.query);
    if (!query.success) return reply.status(400).send({ error: "Invalid query", details: query.error.issues });
    if (!token) throw notFound("Invite not found");
    const invite = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) throw notFound("Invite not found");
    const rawUrl = query.data.url.trim();
    let target: URL;
    try { target = new URL(rawUrl); } catch { throw badRequest("url must be an absolute http(s) URL"); }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw badRequest("url must use http or https");
    const timeoutMs = query.data.timeoutMs;
    const probe = await probeInviteResolutionTarget(target, timeoutMs);
    return reply.send({ inviteId: invite.id, testResolutionPath: `/api/invites/${token}/test-resolution`, requestedUrl: target.toString(), timeoutMs, ...probe });
  });

  fastify.post<{ Params: { token: string } }>("/api/invites/:token/accept", async (req, reply) => {
    const token = req.params.token.trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) throw notFound("Invite not found");
    const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
    const existingJoinRequestForInvite = inviteAlreadyAccepted ? await db.select().from(joinRequests).where(eq(joinRequests.inviteId, invite.id)).then((rows) => rows[0] ?? null) : null;
    const parsed = acceptInviteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as Record<string, unknown>;
    const p = req.principal ?? null;

    if (invite.inviteType === "bootstrap_ceo") {
      if (inviteAlreadyAccepted) throw notFound("Invite not found");
      if (body.requestType !== "human") throw badRequest("Bootstrap invite requires human request type");

      const hasHumanAdmin = await access.hasHumanInstanceAdmin();

      if (p?.type === "user" && p.id) {
        const userId = p.id;
        const existingAdmin = await access.isInstanceAdmin(userId);
        if (!existingAdmin) await access.promoteInstanceAdmin(userId);
        const updatedInvite = await db
          .update(invites)
          .set({ acceptedAt: new Date(), updatedAt: new Date() })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? invite);
        return reply.status(202).send({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId,
          createdAccount: false,
        });
      }

      if (isLocalImplicitF(req)) {
        const userId = "local-board";
        const existingAdmin = await access.isInstanceAdmin(userId);
        if (!existingAdmin) await access.promoteInstanceAdmin(userId);
        const updatedInvite = await db
          .update(invites)
          .set({ acceptedAt: new Date(), updatedAt: new Date() })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? invite);
        return reply.status(202).send({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId,
          createdAccount: false,
        });
      }

      if (opts.deploymentMode !== "authenticated") {
        throw unauthorized("Authenticated user required for bootstrap acceptance");
      }

      if (hasHumanAdmin) {
        throw unauthorized(
          "Sign in with an existing account to accept this invite. If you need a new account, ask an instance admin.",
        );
      }

      const rawName = typeof body.name === "string" ? body.name.trim() : "";
      const rawEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const rawPassword = typeof body.password === "string" ? body.password : "";
      if (!rawName || !rawEmail || !rawPassword) {
        throw badRequest("Provide name, email, and password to create the first admin account.");
      }

      const userId = randomUUID();
      const accountId = randomUUID();
      const now = new Date();
      const passwordHash = await hashPassword(rawPassword);

      const updatedInvite = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(582947123, 1)`);

        const inviteRow = await tx
          .select()
          .from(invites)
          .where(eq(invites.id, invite.id))
          .then((rows) => rows[0] ?? null);
        if (!inviteRow || inviteRow.revokedAt || inviteExpired(inviteRow) || inviteRow.acceptedAt) {
          throw notFound("Invite not found");
        }

        const adminRow = await tx
          .select({ id: instanceUserRoles.id })
          .from(instanceUserRoles)
          .where(
            and(eq(instanceUserRoles.role, "instance_admin"), ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID)),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (adminRow) {
          throw unauthorized(
            "Sign in with an existing account to accept this invite. If you need a new account, ask an instance admin.",
          );
        }

        const userCount = await tx
          .select({ c: count() })
          .from(authUsers)
          .then((rows) => Number(rows[0]?.c ?? 0));
        if (userCount > 0) {
          throw conflict("An account already exists. Sign in to accept the bootstrap invite.");
        }

        const existingEmail = await tx
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.email, rawEmail))
          .then((rows) => rows[0] ?? null);
        if (existingEmail) {
          throw conflict("A user with this email already exists");
        }

        await tx.insert(authUsers).values({
          id: userId,
          name: rawName,
          email: rawEmail,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(authAccounts).values({
          id: accountId,
          accountId: rawEmail,
          providerId: "credential",
          userId,
          accessToken: null,
          refreshToken: null,
          idToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scope: null,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(instanceUserRoles).values({
          userId,
          role: "instance_admin",
        });

        return tx
          .update(invites)
          .set({ acceptedAt: now, updatedAt: now })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? inviteRow);
      });

      return reply.status(202).send({
        inviteId: updatedInvite.id,
        inviteType: updatedInvite.inviteType,
        bootstrapAccepted: true,
        userId,
        createdAccount: true,
        email: rawEmail,
      });
    }

    const requestType = body.requestType as "human" | "agent";
    const companyId = invite.companyId;
    if (!companyId) throw conflict("Invite is missing company scope");
    if (invite.allowedJoinTypes !== "both" && invite.allowedJoinTypes !== requestType) throw badRequest(`Invite does not allow ${requestType} joins`);
    const isBoardAccept = p?.type === "user" || p?.type === "system";
    if (requestType === "human" && !isBoardAccept) throw unauthorized("Human invite acceptance requires authenticated user");
    if (requestType === "human" && !p?.id && !isLocalImplicitF(req)) throw unauthorized("Authenticated user is required");
    if (requestType === "agent" && !body.agentName) {
      if (!inviteAlreadyAccepted || !existingJoinRequestForInvite?.agentName) throw badRequest("agentName is required for agent join requests");
    }
    const adapterType = body.adapterType as string | null ?? null;
    if (requestType === "agent") {
      if (!adapterType || typeof adapterType !== "string" || adapterType.trim() === "") throw unprocessable("adapterType is required for agent join requests");
      assertAdapterTypeAllowed(adapterType);
      const joinAllowed = joinAllowedAdapterTypes;
      if (joinAllowed !== null && joinAllowed.length > 0 && !joinAllowed.includes(adapterType)) throw unprocessable(`This adapter type is not allowed for self-join. Allowed for join: ${joinAllowed.join(", ")}`);
    }
    if (inviteAlreadyAccepted && !existingJoinRequestForInvite) throw notFound("Invite not found");
    const replayJoinRequestId = inviteAlreadyAccepted ? existingJoinRequestForInvite?.id ?? null : null;
    if (inviteAlreadyAccepted && !replayJoinRequestId) throw conflict("Join request not found");

    const replayMergedDefaults = inviteAlreadyAccepted ? mergeJoinDefaultsPayloadForReplay(existingJoinRequestForInvite?.agentDefaultsPayload ?? null, (body.agentDefaultsPayload as Record<string, unknown> | null) ?? null) : (body.agentDefaultsPayload as Record<string, unknown> | null) ?? null;
    const gatewayDefaultsPayload = requestType === "agent" ? buildJoinDefaultsPayloadForAccept({ adapterType, defaultsPayload: replayMergedDefaults }) : null;
    const joinDefaults = requestType === "agent" ? normalizeAgentDefaultsForJoin({ adapterType, defaultsPayload: gatewayDefaultsPayload, deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure, bindHost: opts.bindHost, allowedHostnames: opts.allowedHostnames }) : { normalized: null as Record<string, unknown> | null, diagnostics: [] as JoinDiagnostic[], fatalErrors: [] as string[] };
    if (requestType === "agent" && joinDefaults.fatalErrors.length > 0) throw badRequest(joinDefaults.fatalErrors.join("; "));

    let agentDefaultsPayloadToStore: Record<string, unknown> | null = requestType === "agent" ? joinDefaults.normalized : null;
    if (requestType === "agent" && adapterType) {
      const raw = isPlainObject(replayMergedDefaults) ? (replayMergedDefaults as Record<string, unknown>) : isPlainObject(body.agentDefaultsPayload) ? (body.agentDefaultsPayload as Record<string, unknown>) : {};
      agentDefaultsPayloadToStore = await secretsSvc.normalizeAdapterConfigForPersistence(companyId, raw, { strictMode: false });
      await validateAdapterConfig(adapterType, agentDefaultsPayloadToStore, { companyId, resolveAdapterConfigForRuntime: (cid, cfg) => secretsSvc.resolveAdapterConfigForRuntime(cid, cfg) });
    }
    const claimSecret = requestType === "agent" && !inviteAlreadyAccepted ? createClaimSecret() : null;
    const claimSecretHash = claimSecret ? hashToken(claimSecret) : null;
    const claimSecretExpiresAt = claimSecret ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null;
    const actorEmail = requestType === "human" ? await resolveActorEmailF(db, req) : null;
    const created = !inviteAlreadyAccepted
      ? await db.transaction(async (tx) => {
          await tx.update(invites).set({ acceptedAt: new Date(), updatedAt: new Date() }).where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)));
          return tx.insert(joinRequests).values({ inviteId: invite.id, companyId, requestType, status: "pending_approval", requestIp: requestIpF(req), requestingUserId: requestType === "human" ? (p?.id ?? "local-board") : null, requestEmailSnapshot: requestType === "human" ? actorEmail : null, agentName: requestType === "agent" ? (body.agentName as string | null) : null, adapterType: requestType === "agent" ? adapterType : null, capabilities: requestType === "agent" ? ((body.capabilities ?? null) as string | null) : null, agentDefaultsPayload: requestType === "agent" ? agentDefaultsPayloadToStore : null, claimSecretHash, claimSecretExpiresAt }).returning().then((rows) => rows[0]);
        })
      : await db.update(joinRequests).set({ requestIp: requestIpF(req), agentName: requestType === "agent" ? ((body.agentName as string | undefined) ?? existingJoinRequestForInvite?.agentName ?? null) : null, capabilities: requestType === "agent" ? ((body.capabilities != null ? (body.capabilities as string) : null) ?? existingJoinRequestForInvite?.capabilities ?? null) : null, adapterType: requestType === "agent" ? adapterType : null, agentDefaultsPayload: requestType === "agent" ? agentDefaultsPayloadToStore : null, updatedAt: new Date() }).where(eq(joinRequests.id, replayJoinRequestId as string)).returning().then((rows) => rows[0]);

    if (!created) throw conflict("Join request not found");

    if (inviteAlreadyAccepted && requestType === "agent" && created.status === "approved" && created.createdAgentId) {
      const existingAgent = await agents.getById(created.createdAgentId);
      if (!existingAgent) throw conflict("Approved join request agent not found");
      const existingAdapterConfig = isPlainObject(existingAgent.adapterConfig) ? (existingAgent.adapterConfig as Record<string, unknown>) : {};
      const nextAdapterConfig = { ...existingAdapterConfig, ...(joinDefaults.normalized ?? {}) };
      const updatedAgent = await agents.update(created.createdAgentId, { adapterType: adapterType ?? undefined, adapterConfig: nextAdapterConfig });
      if (!updatedAgent) throw conflict("Approved join request agent not found");
      await logActivity(db, { companyId, actorType: p?.type === "agent" ? "agent" : "user", actorId: p?.type === "agent" ? p.id : p?.id ?? "board", action: "agent.updated_from_join_replay", entityType: "agent", entityId: updatedAgent.id, details: { inviteId: invite.id, joinRequestId: created.id } });
    }

    await logActivity(db, { companyId, actorType: p?.type === "agent" ? "agent" : "user", actorId: p?.type === "agent" ? p.id : p?.id ?? (requestType === "agent" ? "invite-anon" : "board"), action: inviteAlreadyAccepted ? "join.request_replayed" : "join.requested", entityType: "join_request", entityId: created.id, details: { requestType, requestIp: created.requestIp, inviteReplay: inviteAlreadyAccepted } });
    const response = toJoinRequestResponse(created);
    if (claimSecret) {
      const onboardingManifest = buildInviteOnboardingManifest(req, token, invite, opts);
      return reply.status(202).send({ ...response, claimSecret, claimApiKeyPath: `/api/join-requests/${created.id}/claim-api-key`, onboarding: onboardingManifest.onboarding, diagnostics: joinDefaults.diagnostics });
    }
    return reply.status(202).send({ ...response, ...(joinDefaults.diagnostics.length > 0 ? { diagnostics: joinDefaults.diagnostics } : {}) });
  });

  fastify.post<{ Params: { inviteId: string } }>("/api/invites/:inviteId/revoke", async (req, reply) => {
    const id = req.params.inviteId;
    const invite = await db.select().from(invites).where(eq(invites.id, id)).then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.inviteType === "bootstrap_ceo") {
      await assertInstanceAdminF(req);
    } else {
      if (!invite.companyId) throw conflict("Invite is missing company scope");
      await assertCompanyPermission(db, req, invite.companyId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("Invite already consumed");
    if (invite.revokedAt) return reply.send(invite);
    const revoked = await db.update(invites).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(invites.id, id)).returning().then((rows) => rows[0]);
    if (invite.companyId) {
      const p = req.principal ?? null;
      await logActivity(db, { companyId: invite.companyId, actorType: p?.type === "agent" ? "agent" : "user", actorId: p?.type === "agent" ? p.id : p?.id ?? "board", action: "invite.revoked", entityType: "invite", entityId: id });
    }
    return reply.send(revoked);
  });
}
