import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { vcsWebhookDeliveries } from "@hive/db";
import { processGithubPullRequestMerge, verifyGithubWebhookSignature } from "../services/vcs-github-webhook.js";
import { logger } from "../middleware/logger.js";

export async function githubWebhookPlugin(
  fastify: FastifyInstance,
  opts: {
    enabled: boolean;
    secret: string | undefined;
    allowedRepos?: string[];
    db: Db;
  },
): Promise<void> {
  const secret = opts.secret?.trim();
  if (!opts.enabled || !secret) return;

  // Register a raw-body content-type parser scoped to this plugin only.
  // The parser stores the raw Buffer at req.rawBody for HMAC verification.
  fastify.addContentTypeParser(
    ["application/json", "application/*+json"],
    { parseAs: "buffer", bodyLimit: 512 * 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );

  fastify.post<{
    Params: { companyId: string };
  }>(
    "/api/companies/:companyId/integrations/github/webhook",
    async (req, reply) => {
      const companyId = req.params.companyId;
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      const raw = req.body as Buffer;

      if (!Buffer.isBuffer(raw) || raw.length === 0) {
        return reply.status(400).send({ error: "empty body" });
      }
      if (!verifyGithubWebhookSignature(raw, secret, sig)) {
        return reply.status(401).send({ error: "invalid signature" });
      }

      const delivery = (req.headers["x-github-delivery"] as string | undefined)?.trim();
      if (delivery) {
        const [row] = await opts.db
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
          return reply.status(202).send({ ok: true, duplicate: true });
        }
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.status(400).send({ error: "invalid json" });
      }

      const event = (req.headers["x-github-event"] as string | undefined)?.trim();
      if (event === "ping") {
        return reply.status(200).send({ ok: true, ping: true });
      }
      if (event === "pull_request") {
        try {
          const out = await processGithubPullRequestMerge(opts.db, companyId, json, {
            allowedRepos: opts.allowedRepos,
          });
          return reply.status(200).send({ ok: true, ...out });
        } catch (err) {
          logger.error({ err, companyId }, "github webhook pull_request handling failed");
          return reply.status(500).send({ error: "handler failed" });
        }
      }

      return reply.status(202).send({ ok: true, ignored: true });
    },
  );
}
