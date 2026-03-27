import { z } from "zod";

export const COST_EVENT_SOURCES = ["agent_run", "rag_index", "gateway_aggregate"] as const;

export const createCostEventSchema = z
  .object({
    agentId: z.string().uuid().optional().nullable(),
    source: z.enum(COST_EVENT_SOURCES).optional().default("agent_run"),
    issueId: z.string().uuid().optional().nullable(),
    projectId: z.string().uuid().optional().nullable(),
    goalId: z.string().uuid().optional().nullable(),
    billingCode: z.string().optional().nullable(),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative().optional().default(0),
    outputTokens: z.number().int().nonnegative().optional().default(0),
    costCents: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
  })
  .refine(
    (d) =>
      d.agentId != null ||
      d.source === "rag_index" ||
      d.source === "gateway_aggregate",
    { message: "agentId is required when source is agent_run", path: ["agentId"] },
  );

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;

export const costsDateRangeQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(["day", "week"]).optional(),
});

export type CostsDateRangeQuery = z.infer<typeof costsDateRangeQuerySchema>;
