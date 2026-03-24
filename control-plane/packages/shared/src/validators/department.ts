import { z } from "zod";
import { DEPARTMENT_STATUSES, MEMBERSHIP_STATUSES, PRINCIPAL_TYPES } from "../constants.js";

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
  productionPolicies: z.string().max(64_000).optional().nullable(),
});

export type CreateDepartment = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
    .optional(),
  status: z.enum(DEPARTMENT_STATUSES).optional(),
  productionPolicies: z.string().max(64_000).optional().nullable(),
});

export type UpdateDepartment = z.infer<typeof updateDepartmentSchema>;

export const upsertDepartmentMembershipSchema = z.object({
  principalType: z.enum(PRINCIPAL_TYPES),
  principalId: z.string().min(1).max(255),
  isPrimary: z.boolean().optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
});

export type UpsertDepartmentMembership = z.infer<typeof upsertDepartmentMembershipSchema>;

export const listDepartmentMembershipsQuerySchema = z.object({
  principalType: z.enum(PRINCIPAL_TYPES).optional(),
  principalId: z.string().min(1).max(255).optional(),
});

export type ListDepartmentMembershipsQuery = z.infer<typeof listDepartmentMembershipsQuerySchema>;
