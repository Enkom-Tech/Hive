import { z } from "zod";
import { COMPANY_STATUSES } from "../constants.js";

/** Optional query schema for routes that resolve by shortname (e.g. GET /projects/:id with companyId query). */
export const optionalCompanyIdQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

export type OptionalCompanyIdQuery = z.infer<typeof optionalCompanyIdQuerySchema>;

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  productionPolicies: z.string().max(64_000).optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    requireQualityReviewForDone: z.boolean().optional(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    /** JSON string: per-company hive-worker runtime manifest (adapter URLs, checksums). Null clears. */
    workerRuntimeManifestJson: z.string().max(512_000).nullable().optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;
