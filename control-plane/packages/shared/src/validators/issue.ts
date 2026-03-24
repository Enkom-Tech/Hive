import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(["inherit", "project_primary", "isolated", "agent_default"]).optional(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.string(), z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

export const createIssueSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  departmentId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  requiresQualityReview: z.boolean().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
});

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const updateIssueSchema = createIssueSchema.partial().extend({
  comment: z.string().min(1).optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
  requiresQualityReview: z.boolean().optional().nullable(),
});

export type UpdateIssue = z.infer<typeof updateIssueSchema>;
export type IssueExecutionWorkspaceSettings = z.infer<typeof issueExecutionWorkspaceSettingsSchema>;

export const checkoutIssueSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

const MAX_LIST_ISSUES_QUERY_LENGTH = 500;

const ISSUE_STATUS_SET = new Set(ISSUE_STATUSES as readonly string[]);

/** Comma-separated issue statuses (same as list filter in `issueService.list`). */
export const listIssuesStatusQuerySchema = z
  .string()
  .max(MAX_LIST_ISSUES_QUERY_LENGTH)
  .refine(
    (val) => {
      const parts = val
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parts.length > 0 && parts.every((s) => ISSUE_STATUS_SET.has(s));
    },
    { message: "Invalid issue status filter" },
  );

export const listIssuesQuerySchema = z.object({
  status: listIssuesStatusQuerySchema.optional(),
  assigneeAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().max(MAX_LIST_ISSUES_QUERY_LENGTH).optional(),
  touchedByUserId: z.string().max(MAX_LIST_ISSUES_QUERY_LENGTH).optional(),
  unreadForUserId: z.string().max(MAX_LIST_ISSUES_QUERY_LENGTH).optional(),
  projectId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  labelId: z.string().uuid().optional(),
  q: z.string().max(MAX_LIST_ISSUES_QUERY_LENGTH).optional(),
});

export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;
