import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, workerPairingRequests } from "@hive/db";
import { notFound, conflict, forbidden } from "../errors.js";
import { publishLiveEvent } from "./live-events.js";

export const PAIRING_REQUEST_TTL_SEC = 900;

export const PAIRING_STATUS = {
  pending: "pending",
  awaiting_token_fetch: "awaiting_token_fetch",
  delivered: "delivered",
  rejected: "rejected",
  expired: "expired",
} as const;

export type PairingStatus = (typeof PAIRING_STATUS)[keyof typeof PAIRING_STATUS];

export type WorkerPairingMintEnrollment = (
  agentId: string,
  ttlSeconds: number,
) => Promise<{ token: string; expiresAt: Date }>;

export function workerPairingService(
  db: Db,
  deps: { mintEnrollment: WorkerPairingMintEnrollment },
) {
  const { mintEnrollment } = deps;

  async function expireStaleForCompany(companyId: string) {
    const now = new Date();
    await db
      .update(workerPairingRequests)
      .set({ status: PAIRING_STATUS.expired })
      .where(
        and(
          eq(workerPairingRequests.companyId, companyId),
          lt(workerPairingRequests.expiresAt, now),
          inArray(workerPairingRequests.status, [
            PAIRING_STATUS.pending,
            PAIRING_STATUS.awaiting_token_fetch,
          ]),
        ),
      );
  }

  async function openPairingWindow(agentId: string, ttlSeconds: number) {
    const ttl = Math.min(3600, Math.max(120, Math.floor(ttlSeconds) || 900));
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Agent not found");
    if (row.adapterType !== "managed_worker") {
      throw conflict("Pairing is only for managed_worker agents");
    }
    if (row.status === "terminated" || row.status === "pending_approval") {
      throw conflict("Agent cannot accept worker pairing");
    }
    const until = new Date(Date.now() + ttl * 1000);
    await db
      .update(agents)
      .set({ pairingWindowExpiresAt: until, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    return { expiresAt: until };
  }

  async function createAnonymousRequest(opts: {
    agentId: string;
    clientInfo?: Record<string, unknown> | null;
    requestIp: string;
  }) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, opts.agentId))
      .then((r) => r[0] ?? null);
    if (!row) {
      throw notFound("Unknown agent");
    }
    if (row.adapterType !== "managed_worker") {
      throw forbidden("Pairing not available for this agent");
    }
    if (row.status === "terminated" || row.status === "pending_approval") {
      throw forbidden("Agent cannot accept workers");
    }
    const win = row.pairingWindowExpiresAt;
    if (!win || win <= new Date()) {
      throw forbidden("Pairing window is closed. Open it on the board (Workers / agent) and try again.");
    }

    await expireStaleForCompany(row.companyId);

    const expiresAt = new Date(Date.now() + PAIRING_REQUEST_TTL_SEC * 1000);
    const inserted = await db
      .insert(workerPairingRequests)
      .values({
        companyId: row.companyId,
        agentId: row.id,
        status: PAIRING_STATUS.pending,
        clientInfo: opts.clientInfo ?? null,
        requestIp: opts.requestIp,
        expiresAt,
      })
      .returning({ id: workerPairingRequests.id })
      .then((r) => r[0]);
    if (!inserted) throw conflict("Could not create pairing request");
    publishLiveEvent({
      companyId: row.companyId,
      type: "worker.pairing.pending",
      payload: {
        requestId: inserted.id,
        agentId: row.id,
        agentName: row.name,
      },
    });
    return { requestId: inserted.id, expiresAt };
  }

  async function pollRequest(requestId: string) {
    const row = await db
      .select()
      .from(workerPairingRequests)
      .where(eq(workerPairingRequests.id, requestId))
      .then((r) => r[0] ?? null);
    if (!row) {
      return { status: "not_found" as const };
    }
    const now = new Date();
    if (
      row.expiresAt < now &&
      (row.status === PAIRING_STATUS.pending || row.status === PAIRING_STATUS.awaiting_token_fetch)
    ) {
      await db
        .update(workerPairingRequests)
        .set({ status: PAIRING_STATUS.expired })
        .where(eq(workerPairingRequests.id, requestId));
      return { status: "expired" as const };
    }
    if (row.status === PAIRING_STATUS.pending) {
      return { status: "pending" as const };
    }
    if (row.status === PAIRING_STATUS.rejected) {
      return { status: "rejected" as const };
    }
    if (row.status === PAIRING_STATUS.delivered) {
      return { status: "delivered" as const };
    }
    if (row.status === PAIRING_STATUS.expired) {
      return { status: "expired" as const };
    }
    if (row.status === PAIRING_STATUS.awaiting_token_fetch && row.enrollmentTokenPlaintext) {
      const token = row.enrollmentTokenPlaintext;
      const updated = await db
        .update(workerPairingRequests)
        .set({
          status: PAIRING_STATUS.delivered,
          enrollmentTokenPlaintext: null,
          deliveredAt: new Date(),
        })
        .where(
          and(
            eq(workerPairingRequests.id, requestId),
            eq(workerPairingRequests.status, PAIRING_STATUS.awaiting_token_fetch),
          ),
        )
        .returning({ id: workerPairingRequests.id })
        .then((r) => r[0] ?? null);
      if (!updated) {
        return { status: "pending" as const };
      }
      return {
        status: "ready" as const,
        enrollmentToken: token,
        agentId: row.agentId,
        companyId: row.companyId,
      };
    }
    return { status: "pending" as const };
  }

  async function listPendingForCompany(companyId: string) {
    await expireStaleForCompany(companyId);
    const rows = await db
      .select({
        id: workerPairingRequests.id,
        agentId: workerPairingRequests.agentId,
        agentName: agents.name,
        status: workerPairingRequests.status,
        clientInfo: workerPairingRequests.clientInfo,
        requestIp: workerPairingRequests.requestIp,
        createdAt: workerPairingRequests.createdAt,
        expiresAt: workerPairingRequests.expiresAt,
      })
      .from(workerPairingRequests)
      .innerJoin(agents, eq(workerPairingRequests.agentId, agents.id))
      .where(
        and(
          eq(workerPairingRequests.companyId, companyId),
          eq(workerPairingRequests.status, PAIRING_STATUS.pending),
        ),
      )
      .orderBy(asc(workerPairingRequests.createdAt));

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      agentName: r.agentName,
      status: r.status,
      clientInfo: r.clientInfo,
      requestIp: r.requestIp,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  }

  async function countPendingForCompany(companyId: string): Promise<number> {
    await expireStaleForCompany(companyId);
    const row = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workerPairingRequests)
      .where(
        and(
          eq(workerPairingRequests.companyId, companyId),
          eq(workerPairingRequests.status, PAIRING_STATUS.pending),
        ),
      )
      .then((r) => r[0]);
    return Number(row?.count ?? 0);
  }

  async function approveRequest(opts: {
    companyId: string;
    agentId: string;
    requestId: string;
    approvedByUserId: string;
  }) {
    await expireStaleForCompany(opts.companyId);
    const row = await db
      .select()
      .from(workerPairingRequests)
      .where(eq(workerPairingRequests.id, opts.requestId))
      .then((r) => r[0] ?? null);
    if (!row || row.companyId !== opts.companyId || row.agentId !== opts.agentId) {
      throw notFound("Pairing request not found");
    }
    if (row.status !== PAIRING_STATUS.pending) {
      throw conflict("Pairing request is no longer pending");
    }
    if (row.expiresAt < new Date()) {
      await db
        .update(workerPairingRequests)
        .set({ status: PAIRING_STATUS.expired })
        .where(eq(workerPairingRequests.id, opts.requestId));
      throw conflict("Pairing request expired");
    }

    const ttlSec = Math.min(
      3600,
      Math.max(120, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)),
    );
    const { token } = await mintEnrollment(opts.agentId, ttlSec);

    const updated = await db
      .update(workerPairingRequests)
      .set({
        status: PAIRING_STATUS.awaiting_token_fetch,
        enrollmentTokenPlaintext: token,
        approvedAt: new Date(),
        approvedByUserId: opts.approvedByUserId,
      })
      .where(
        and(
          eq(workerPairingRequests.id, opts.requestId),
          eq(workerPairingRequests.status, PAIRING_STATUS.pending),
        ),
      )
      .returning({ id: workerPairingRequests.id })
      .then((r) => r[0] ?? null);

    if (!updated) {
      throw conflict("Could not approve pairing request");
    }
  }

  async function rejectRequest(opts: {
    companyId: string;
    agentId: string;
    requestId: string;
    rejectedByUserId: string;
  }) {
    await expireStaleForCompany(opts.companyId);
    const row = await db
      .select()
      .from(workerPairingRequests)
      .where(eq(workerPairingRequests.id, opts.requestId))
      .then((r) => r[0] ?? null);
    if (!row || row.companyId !== opts.companyId || row.agentId !== opts.agentId) {
      throw notFound("Pairing request not found");
    }
    if (row.status !== PAIRING_STATUS.pending) {
      throw conflict("Pairing request is no longer pending");
    }

    await db
      .update(workerPairingRequests)
      .set({
        status: PAIRING_STATUS.rejected,
        rejectedAt: new Date(),
        rejectedByUserId: opts.rejectedByUserId,
      })
      .where(
        and(
          eq(workerPairingRequests.id, opts.requestId),
          eq(workerPairingRequests.status, PAIRING_STATUS.pending),
        ),
      );
  }

  return {
    openPairingWindow,
    createAnonymousRequest,
    pollRequest,
    listPendingForCompany,
    countPendingForCompany,
    approveRequest,
    rejectRequest,
    expireStaleForCompany,
  };
}
