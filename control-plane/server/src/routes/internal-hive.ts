import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { gatewayVirtualKeys } from "@hive/db";
import { createCostEventSchema, modelTrainingCallbackBodySchema } from "@hive/shared";
import { costService } from "../services/costs.js";
import { modelTrainingService } from "../services/model-training.js";
import { unauthorized } from "../errors.js";

const inferenceMeteringBodySchema = createCostEventSchema.extend({
  companyId: z.string().uuid(),
});

const gatewayVirtualKeyLookupQuerySchema = z
  .object({
    keyHash: z.string().min(1).optional(),
    bifrostVirtualKeyId: z.string().min(1).optional(),
  })
  .refine((q) => Boolean(q.keyHash?.trim()) || Boolean(q.bifrostVirtualKeyId?.trim()), {
    message: "Provide keyHash or bifrostVirtualKeyId",
  });

export async function internalHiveTrainingCallbackPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; internalOperatorSecret?: string },
): Promise<void> {
  const training = modelTrainingService(opts.db, {
    internalOperatorSecret: opts.internalOperatorSecret?.trim() || undefined,
  });

  fastify.post<{ Body: z.infer<typeof modelTrainingCallbackBodySchema> }>(
    "/api/internal/hive/model-training-callback",
    async (req, reply) => {
      const body = modelTrainingCallbackBodySchema.parse(req.body);
      const row = await training.applyCallback(body, req.headers.authorization as string | undefined);
      const { callbackTokenHash: _omit, ...safe } = row;
      return reply.send(safe);
    },
  );
}

/**
 * Fastify-native internal operator routes.
 * Only registered when HIVE_INTERNAL_OPERATOR_SECRET is set.
 */
export async function internalHiveOperatorPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; operatorSecret: string },
): Promise<void> {
  const costs = costService(opts.db);
  const secret = opts.operatorSecret;

  function requireSecret(authHeader: string | undefined): void {
    const tok =
      typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : "";
    if (!tok || tok !== secret) {
      throw unauthorized("Invalid internal operator token");
    }
  }

  fastify.get<{ Querystring: z.infer<typeof gatewayVirtualKeyLookupQuerySchema> }>(
    "/api/internal/hive/gateway-virtual-key-lookup",
    async (req, reply) => {
      requireSecret(req.headers.authorization as string | undefined);
      const q = gatewayVirtualKeyLookupQuerySchema.parse(req.query);
      const keyHash = q.keyHash?.trim();
      const bifrostId = q.bifrostVirtualKeyId?.trim();
      const row = await opts.db
        .select({
          companyId: gatewayVirtualKeys.companyId,
          keyKind: gatewayVirtualKeys.keyKind,
        })
        .from(gatewayVirtualKeys)
        .where(
          and(
            isNull(gatewayVirtualKeys.revokedAt),
            keyHash
              ? eq(gatewayVirtualKeys.keyHash, keyHash)
              : eq(gatewayVirtualKeys.bifrostVirtualKeyId, bifrostId!),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!row) {
        return reply.status(404).send({ error: "Unknown or revoked gateway virtual key" });
      }
      return reply.send({ companyId: row.companyId, keyKind: row.keyKind });
    },
  );

  fastify.post<{ Body: z.infer<typeof inferenceMeteringBodySchema> }>(
    "/api/internal/hive/inference-metering",
    async (req, reply) => {
      requireSecret(req.headers.authorization as string | undefined);
      const { companyId, occurredAt, idempotencyKey, ...rest } = inferenceMeteringBodySchema.parse(req.body);
      const event = await costs.createEvent(companyId, {
        ...rest,
        occurredAt: new Date(occurredAt),
        gatewayMeteringKey: idempotencyKey?.trim() ? idempotencyKey.trim() : null,
      });
      return reply.status(201).send(event);
    },
  );
}
