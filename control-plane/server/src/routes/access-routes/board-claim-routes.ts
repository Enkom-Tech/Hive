import type { Router } from "express";
import type { Db } from "@hive/db";
import {
  boardClaimChallengeQuerySchema,
  claimBoardSchema,
} from "@hive/shared";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { notFound, conflict, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import {
  claimBoardOwnership,
  inspectBoardClaimChallenge,
} from "../../board-claim.js";

export function registerBoardClaimRoutes(router: Router, db: Db): void {
  router.get("/board-claim/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    const query = boardClaimChallengeQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query", details: query.error.issues });
      return;
    }
    const code = query.data.code?.trim();
    if (!token) throw notFound("Board claim challenge not found");
    const challenge = inspectBoardClaimChallenge(token, code);
    if (challenge.status === "invalid")
      throw notFound("Board claim challenge not found");
    res.json(challenge);
  });

  router.post("/board-claim/:token/claim", validate(claimBoardSchema), async (req, res) => {
    const p = getCurrentPrincipal(req);
    const token = (req.params.token as string).trim();
    const code = req.body.code.trim();
    if (!token) throw notFound("Board claim challenge not found");
    if (
      (p?.type !== "user" && p?.type !== "system") ||
      p?.type !== "user" ||
      !p?.id
    ) {
      throw unauthorized("Sign in before claiming board ownership");
    }

    const claimed = await claimBoardOwnership(db, {
      token,
      code,
      userId: p?.id ?? "",
    });

    if (claimed.status === "invalid")
      throw notFound("Board claim challenge not found");
    if (claimed.status === "expired")
      throw conflict(
        "Board claim challenge expired. Restart server to generate a new one.",
      );
    if (claimed.status === "claimed") {
      res.json({
        claimed: true,
        userId: claimed.claimedByUserId ?? p?.id,
      });
      return;
    }

    throw conflict("Board claim challenge is no longer available");
  });
}
