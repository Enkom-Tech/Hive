import {
  createAgentHireSchema,
  createCostEventSchema,
  createIssueSchema,
  ISSUE_STATUSES,
} from "@hive/shared";
import { z } from "zod";

export const WORKER_API_ACTIONS = {
  costReport: "worker_api.cost_report",
  issueAppendComment: "worker_api.issue_append_comment",
  issueTransitionStatus: "worker_api.issue_transition_status",
  issueGet: "worker_api.issue_get",
  issueCreate: "worker_api.issue_create",
  issueUpdate: "worker_api.issue_update",
} as const;

export const workerCostReportSchema = createCostEventSchema.and(
  z.object({
    agentId: z.string().uuid(),
  }),
);

export const workerCreateIssueSchema = createIssueSchema.and(
  z.object({
    agentId: z.string().uuid(),
  }),
);

export const workerIssuePatchSchema = z
  .object({
    agentId: z.string().uuid(),
    title: createIssueSchema.shape.title.optional(),
    description: z.string().optional().nullable(),
    priority: createIssueSchema.shape.priority.optional(),
    projectId: z.string().uuid().optional().nullable(),
    goalId: z.string().uuid().optional().nullable(),
    departmentId: z.string().uuid().optional().nullable(),
    parentId: z.string().uuid().optional().nullable(),
    assigneeAgentId: z.string().uuid().optional().nullable(),
    assigneeUserId: z.string().optional().nullable(),
    billingCode: z.string().optional().nullable(),
    requiresQualityReview: z.boolean().optional().nullable(),
    assigneeAdapterOverrides: createIssueSchema.shape.assigneeAdapterOverrides,
    executionWorkspaceSettings: createIssueSchema.shape.executionWorkspaceSettings,
    labelIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export const workerAgentHireSchema = createAgentHireSchema.extend({
  agentId: z.string().uuid(),
});

export const issueAppendBodySchema = z.object({
  agentId: z.string().uuid(),
  body: z.string().min(1).max(256_000),
});

const issueStatuses = ISSUE_STATUSES as readonly string[];

export const pluginToolsQuerySchema = z.object({
  agentId: z.string().uuid(),
});

export const issueTransitionBodySchema = z.object({
  agentId: z.string().uuid(),
  status: z
    .string()
    .min(1)
    .refine((s) => issueStatuses.includes(s), { message: "Invalid issue status" }),
});

export const issueGetQuerySchema = z.object({
  agentId: z.string().uuid(),
});
