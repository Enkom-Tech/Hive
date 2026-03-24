import { z } from "zod";
import { PROJECT_STATUSES } from "../constants.js";

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

export const projectExecutionWorkspacePolicySchema = z
  .object({
    enabled: z.boolean(),
    defaultMode: z.enum(["project_primary", "isolated"]).optional(),
    allowIssueOverride: z.boolean().optional(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
    branchPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    pullRequestPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    cleanupPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

const projectWorkspaceFields = {
  name: z.string().min(1).optional(),
  cwd: z.string().min(1).optional().nullable(),
  repoUrl: z.string().url().optional().nullable(),
  repoRef: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
};

export const createProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  const hasCwd = typeof value.cwd === "string" && value.cwd.trim().length > 0;
  const hasRepo = typeof value.repoUrl === "string" && value.repoUrl.trim().length > 0;
  if (!hasCwd && !hasRepo) {
    ctx.issues.push({
      code: z.ZodIssueCode.custom,
      input: value,
      message: "Workspace requires at least one of cwd or repoUrl.",
      path: ["cwd"],
    });
  }
});

export type CreateProjectWorkspace = z.infer<typeof createProjectWorkspaceSchema>;

export const updateProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional(),
}).partial();

export type UpdateProjectWorkspace = z.infer<typeof updateProjectWorkspaceSchema>;

const projectFields = {
  /** @deprecated Use goalIds instead */
  goalId: z.string().uuid().optional().nullable(),
  goalIds: z.array(z.string().uuid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  productionPolicies: z.string().max(64_000).optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().uuid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  executionWorkspacePolicy: projectExecutionWorkspacePolicySchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

export const createProjectSchema = z.object({
  ...projectFields,
  workspace: createProjectWorkspaceSchema.optional(),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object(projectFields).partial();

export type UpdateProject = z.infer<typeof updateProjectSchema>;

export type ProjectExecutionWorkspacePolicy = z.infer<typeof projectExecutionWorkspacePolicySchema>;
