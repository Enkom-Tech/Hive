import type { Project, ProjectStatus } from "@hive/shared";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS } from "@hive/shared";

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";

export type ProjectConfigFieldKey =
  | "name"
  | "description"
  | "status"
  | "goals"
  | "execution_workspace_enabled"
  | "execution_workspace_default_mode"
  | "execution_workspace_base_ref"
  | "execution_workspace_branch_template"
  | "execution_workspace_worktree_parent_dir"
  | "execution_workspace_provision_command"
  | "execution_workspace_teardown_command";

export interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
}

export const REPO_ONLY_CWD_SENTINEL = "/__HIVE_repo_only__";

// Deferred: per-issue worktrees — see doc/plugins/ and product roadmap; re-enable when workflow ships.
export const SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = true;

export const PROJECT_STATUS_OPTIONS = PROJECT_STATUSES.map((value: ProjectStatus) => ({
  value,
  label: PROJECT_STATUS_LABELS[value],
}));
