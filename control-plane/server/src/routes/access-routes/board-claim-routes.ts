import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import {
  boardClaimChallengeQuerySchema,
  claimBoardSchema,
} from "@hive/shared";
import { notFound, conflict, unauthorized } from "../../errors.js";
import {
  claimBoardOwnership,
  inspectBoardClaimChallenge,
} from "../../board-claim.js";

export function registerBoardClaimRoutesF(fastify: FastifyInstance, db: Db): void {
  fastify.get<{ Params: { token: string } }>("/api/board-claim/:token", async (req, reply) => {
    const token = req.params.token.trim();
    const query = boardClaimChallengeQuerySchema.safeParse(req.query);
    if (!query.success) return reply.status(400).send({ error: "Invalid query", details: query.error.issues });
    const code = query.data.code?.trim();
    if (!token) throw notFound("Board claim challenge not found");
    const challenge = inspectBoardClaimChallenge(token, code);
    if (challenge.status === "invalid") throw notFound("Board claim challenge not found");
    return reply.send(challenge);
  });

  fastify.post<{ Params: { token: string } }>("/api/board-claim/:token/claim", async (req, reply) => {
    const p = req.principal ?? null;
    const token = req.params.token.trim();
    const parsed = claimBoardSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    if (!token) throw notFound("Board claim challenge not found");
    if (p?.type !== "user" || !p?.id) throw unauthorized("Sign in before claiming board ownership");
    const claimed = await claimBoardOwnership(db, { token, code: (parsed.data as { code: string }).code.trim(), userId: p.id });
    if (claimed.status === "invalid") throw notFound("Board claim challenge not found");
    if (claimed.status === "expired") throw conflict("Board claim challenge expired. Restart server to generate a new one.");
    if (claimed.status === "claimed") return reply.send({ claimed: true, userId: claimed.claimedByUserId ?? p.id });
    throw conflict("Board claim challenge is no longer available");
  });
}
