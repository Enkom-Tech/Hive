import { z } from "zod";

export const webhookDeliveryRetrySchema = z.object({
  issueId: z.string().uuid(),
  agentId: z.string().uuid(),
  eventType: z.enum(["work_available"]).optional(),
});

export type WebhookDeliveryRetry = z.infer<typeof webhookDeliveryRetrySchema>;

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export const listWebhookDeliveriesQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? parseInt(s, 10) : DEFAULT_LIMIT;
      if (!Number.isFinite(n)) return DEFAULT_LIMIT;
      return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, n));
    }),
  since: z.string().optional(),
  agentId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  status: z.enum(["success", "failed"]).optional(),
});

export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;
