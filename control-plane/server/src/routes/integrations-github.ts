import type { Express, Request, Response } from "express";
import express from "express";
import type { Db } from "@hive/db";
import { vcsWebhookDeliveries } from "@hive/db";
import { processGithubPullRequestMerge, verifyGithubWebhookSignature } from "../services/vcs-github-webhook.js";
import { logger } from "../middleware/logger.js";

/**
 * Register GitHub webhook **before** `express.json()` so HMAC is verified on the raw body.
 */
export function registerGithubWebhookBeforeJson(
  app: Express,
  db: Db,
  opts: {
    enabled: boolean;
    secret: string | undefined;
    allowedRepos?: string[];
  },
): void {
  const secret = opts.secret?.trim();
  if (!opts.enabled || !secret) return;

  app.post(
    "/api/companies/:companyId/integrations/github/webhook",
    express.raw({ type: ["application/json", "application/*+json"], limit: "512kb" }),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const sig = req.get("x-hub-signature-256");
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || raw.length === 0) {
        res.status(400).json({ error: "empty body" });
        return;
      }
      if (!verifyGithubWebhookSignature(raw, secret, sig)) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      const delivery = req.get("x-github-delivery")?.trim();
      if (delivery) {
        const [row] = await db
          .insert(vcsWebhookDeliveries)
          .values({
            companyId,
            provider: "github",
            deliveryId: delivery,
          })
          .onConflictDoNothing({
            target: [
              vcsWebhookDeliveries.companyId,
              vcsWebhookDeliveries.provider,
              vcsWebhookDeliveries.deliveryId,
            ],
          })
          .returning({ id: vcsWebhookDeliveries.id });
        if (!row) {
          res.status(202).json({ ok: true, duplicate: true });
          return;
        }
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        res.status(400).json({ error: "invalid json" });
        return;
      }

      const event = req.get("x-github-event")?.trim();
      if (event === "ping") {
        res.status(200).json({ ok: true, ping: true });
        return;
      }
      if (event === "pull_request") {
        try {
          const out = await processGithubPullRequestMerge(db, companyId, json, {
            allowedRepos: opts.allowedRepos,
          });
          res.status(200).json({ ok: true, ...out });
        } catch (err) {
          logger.error({ err, companyId }, "github webhook pull_request handling failed");
          res.status(500).json({ error: "handler failed" });
        }
        return;
      }

      res.status(202).json({ ok: true, ignored: true });
    },
  );
}
