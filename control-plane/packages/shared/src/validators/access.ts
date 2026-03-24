import { z } from "zod";
import {
  INVITE_JOIN_TYPES,
  JOIN_REQUEST_STATUSES,
  JOIN_REQUEST_TYPES,
  PERMISSION_KEYS,
} from "../constants.js";

export const createCompanyInviteSchema = z.object({
  allowedJoinTypes: z.enum(INVITE_JOIN_TYPES).default("both"),
  defaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
  agentMessage: z.string().max(4000).optional().nullable(),
});

export type CreateCompanyInvite = z.infer<typeof createCompanyInviteSchema>;

export const acceptInviteSchema = z.object({
  requestType: z.enum(JOIN_REQUEST_TYPES),
  agentName: z.string().min(1).max(120).optional(),
  adapterType: z.string().min(1).max(64).optional(),
  capabilities: z.string().max(4000).optional().nullable(),
  agentDefaultsPayload: z.record(z.string(), z.unknown()).optional().nullable(),
  // OpenClaw join compatibility fields accepted at top level.
  responsesWebhookUrl: z.string().max(4000).optional().nullable(),
  responsesWebhookMethod: z.string().max(32).optional().nullable(),
  responsesWebhookHeaders: z.record(z.string(), z.unknown()).optional().nullable(),
  hiveApiUrl: z.string().max(4000).optional().nullable(),
  webhookAuthHeader: z.string().max(4000).optional().nullable(),
});

export type AcceptInvite = z.infer<typeof acceptInviteSchema>;

export const listJoinRequestsQuerySchema = z.object({
  status: z.enum(JOIN_REQUEST_STATUSES).optional(),
  requestType: z.enum(JOIN_REQUEST_TYPES).optional(),
});

export type ListJoinRequestsQuery = z.infer<typeof listJoinRequestsQuerySchema>;

export const claimJoinRequestApiKeySchema = z.object({
  claimSecret: z.string().min(16).max(256),
});

export type ClaimJoinRequestApiKey = z.infer<typeof claimJoinRequestApiKeySchema>;

export const updateMemberPermissionsSchema = z.object({
  grants: z.array(
    z.object({
      permissionKey: z.enum(PERMISSION_KEYS),
      scope: z.record(z.string(), z.unknown()).optional().nullable(),
    }),
  ),
});

export type UpdateMemberPermissions = z.infer<typeof updateMemberPermissionsSchema>;

export const updateUserCompanyAccessSchema = z.object({
  companyIds: z.array(z.string().uuid()).default([]),
});

export type UpdateUserCompanyAccess = z.infer<typeof updateUserCompanyAccessSchema>;

export const claimBoardSchema = z.object({
  code: z.string().min(1, "Claim code is required"),
});

export type ClaimBoard = z.infer<typeof claimBoardSchema>;

export const boardClaimChallengeQuerySchema = z.object({
  code: z.string().optional(),
});

export type BoardClaimChallengeQuery = z.infer<typeof boardClaimChallengeQuerySchema>;

export const inviteTestResolutionQuerySchema = z.object({
  url: z.string().min(1, "url query parameter is required"),
  timeoutMs: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? Number(s) : NaN;
      return Number.isFinite(n) ? Math.max(1000, Math.min(15000, Math.floor(n))) : 5000;
    }),
});

export type InviteTestResolutionQuery = z.infer<typeof inviteTestResolutionQuerySchema>;
