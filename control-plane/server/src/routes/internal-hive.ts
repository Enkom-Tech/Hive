import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { gatewayVirtualKeys } from "@hive/db";
import { createCostEventSchema, modelTrainingCallbackBodySchema } from "@hive/shared";
import { validate } from "../middleware/validate.js";
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

function requireOperatorSecret(secret: string) {
  return function operatorSecretMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const h = req.headers.authorization;
    const tok =
      typeof h === "string" && h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!tok || tok !== secret) {
      next(unauthorized("Invalid internal operator token"));
      return;
    }
    next();
  };
}

/**
 * Training runner callbacks: Bearer per-run token (from dispatch) or optional operator secret.
 * Mounted at /api/internal/hive even when HIVE_INTERNAL_OPERATOR_SECRET is unset so runners work token-only.
 */
export function internalHiveTrainingCallbackRoutes(
  db: Db,
  opts?: { internalOperatorSecret?: string },
): Router {
  const router = Router();
  const training = modelTrainingService(db, {
    internalOperatorSecret: opts?.internalOperatorSecret?.trim() || undefined,
  });

  router.post("/model-training-callback", validate(modelTrainingCallbackBodySchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof modelTrainingCallbackBodySchema>;
      const row = await training.applyCallback(body, req.headers.authorization);
      const { callbackTokenHash: _omit, ...safe } = row;
      res.json(safe);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/**
 * Internal webhooks that require Authorization: Bearer <HIVE_INTERNAL_OPERATOR_SECRET>
 * (gateway virtual key lookup, inference metering).
 */
export function internalHiveOperatorRoutes(db: Db, opts: { operatorSecret: string }): Router {
  const router = Router();
  const costs = costService(db);
  const requireSecret = requireOperatorSecret(opts.operatorSecret);

  router.get("/gateway-virtual-key-lookup", requireSecret, async (req, res, next) => {
    try {
      const q = gatewayVirtualKeyLookupQuerySchema.parse(req.query);
      const keyHash = q.keyHash?.trim();
      const bifrostId = q.bifrostVirtualKeyId?.trim();
      const row = await db
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
        res.status(404).json({ error: "Unknown or revoked gateway virtual key" });
        return;
      }
      res.json({ companyId: row.companyId, keyKind: row.keyKind });
    } catch (e) {
      next(e);
    }
  });

  router.post(
    "/inference-metering",
    requireSecret,
    validate(inferenceMeteringBodySchema),
    async (req, res, next) => {
      try {
        const { companyId, occurredAt, idempotencyKey, ...rest } = req.body as z.infer<
          typeof inferenceMeteringBodySchema
        >;
        const event = await costs.createEvent(companyId, {
          ...rest,
          occurredAt: new Date(occurredAt),
          gatewayMeteringKey: idempotencyKey?.trim() ? idempotencyKey.trim() : null,
        });
        res.status(201).json(event);
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
