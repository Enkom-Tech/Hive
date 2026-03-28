import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@hive/shared";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Separator } from "@/components/ui/separator";
import type { ProjectConfigFieldKey, ProjectFieldSaveState, ProjectPropertiesProps } from "./project-properties/project-properties-types";
import {
  REPO_ONLY_CWD_SENTINEL,
  SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI,
} from "./project-properties/project-properties-types";
import {
  deriveWorkspaceNameFromPath,
  deriveWorkspaceNameFromRepo,
  isAbsolutePath,
  isGitHubRepoUrl,
} from "./project-properties/project-properties-workspace-utils";
import { ProjectPropertiesCoreFields } from "./project-properties/ProjectPropertiesCoreFields";
import { ProjectWorkspacesSection } from "./project-properties/ProjectWorkspacesSection";
import { ProjectExecutionWorkspaceSection } from "./project-properties/ProjectExecutionWorkspaceSection";

export type { ProjectFieldSaveState, ProjectConfigFieldKey } from "./project-properties/project-properties-types";

export function ProjectProperties({ project, onUpdate, onFieldUpdate, getFieldSaveState }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [executionWorkspaceAdvancedOpen, setExecutionWorkspaceAdvancedOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "repo" | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    if (onFieldUpdate) {
      onFieldUpdate(field, data);
      return;
    }
    onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState => getFieldSaveState?.(field) ?? "idle";
  const canEdit = Boolean(onUpdate || onFieldUpdate);

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const linkedGoalIds =
    project.goalIds.length > 0 ? project.goalIds : project.goalId ? [project.goalId] : [];

  const linkedGoals =
    project.goals.length > 0
      ? project.goals
      : linkedGoalIds.map((id) => ({
          id,
          title: allGoals?.find((g) => g.id === id)?.title ?? id.slice(0, 8),
        }));

  const availableGoals = (allGoals ?? []).filter((g) => !linkedGoalIds.includes(g.id));
  const workspaces = project.workspaces ?? [];
  const executionWorkspacePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorkspacesEnabled = executionWorkspacePolicy?.enabled === true;
  const executionWorkspaceDefaultMode =
    executionWorkspacePolicy?.defaultMode === "isolated" ? "isolated" : "project_primary";
  const executionWorkspaceStrategy = executionWorkspacePolicy?.workspaceStrategy ?? {
    type: "git_worktree" as const,
    baseRef: "",
    branchTemplate: "",
    worktreeParentDir: "",
  };

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
    }
  };

  const createWorkspace = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.createWorkspace(project.id, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: invalidateProject,
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, workspaceId, data),
    onSuccess: invalidateProject,
  });

  const removeGoal = (goalId: string) => {
    if (!onUpdate && !onFieldUpdate) return;
    commitField("goals", { goalIds: linkedGoalIds.filter((id) => id !== goalId) });
  };

  const addGoal = (goalId: string) => {
    if ((!onUpdate && !onFieldUpdate) || linkedGoalIds.includes(goalId)) return;
    commitField("goals", { goalIds: [...linkedGoalIds, goalId] });
    setGoalOpen(false);
  };

  const updateExecutionWorkspacePolicy = (patch: Record<string, unknown>) => {
    if (!onUpdate && !onFieldUpdate) return;
    return {
      executionWorkspacePolicy: {
        enabled: executionWorkspacesEnabled,
        defaultMode: executionWorkspaceDefaultMode,
        allowIssueOverride: executionWorkspacePolicy?.allowIssueOverride ?? true,
        ...executionWorkspacePolicy,
        ...patch,
      },
    };
  };

  const submitLocalWorkspace = () => {
    const cwd = workspaceCwd.trim();
    if (!isAbsolutePath(cwd)) {
      setWorkspaceError("Local folder must be a full absolute path.");
      return;
    }
    setWorkspaceError(null);
    createWorkspace.mutate({
      name: deriveWorkspaceNameFromPath(cwd),
      cwd,
    });
  };

  const submitRepoWorkspace = () => {
    const repoUrl = workspaceRepoUrl.trim();
    if (!isGitHubRepoUrl(repoUrl)) {
      setWorkspaceError("Repo workspace must use a valid GitHub repo URL.");
      return;
    }
    setWorkspaceError(null);
    createWorkspace.mutate({
      name: deriveWorkspaceNameFromRepo(repoUrl),
      cwd: REPO_ONLY_CWD_SENTINEL,
      repoUrl,
    });
  };

  const clearLocalWorkspace = (workspace: Project["workspaces"][number]) => {
    const confirmed = window.confirm(
      workspace.repoUrl ? "Clear local folder from this workspace?" : "Delete this workspace local folder?",
    );
    if (!confirmed) return;
    if (workspace.repoUrl) {
      updateWorkspace.mutate({
        workspaceId: workspace.id,
        data: { cwd: null },
      });
      return;
    }
    removeWorkspace.mutate(workspace.id);
  };

  const clearRepoWorkspace = (workspace: Project["workspaces"][number]) => {
    const hasLocalFolder = Boolean(workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL);
    const confirmed = window.confirm(
      hasLocalFolder ? "Clear GitHub repo from this workspace?" : "Delete this workspace repo?",
    );
    if (!confirmed) return;
    if (hasLocalFolder) {
      updateWorkspace.mutate({
        workspaceId: workspace.id,
        data: { repoUrl: null, repoRef: null },
      });
      return;
    }
    removeWorkspace.mutate(workspace.id);
  };

  return (
    <div>
      <ProjectPropertiesCoreFields
        project={project}
        canEdit={canEdit}
        fieldState={fieldState}
        commitField={commitField}
        linkedGoals={linkedGoals}
        availableGoals={availableGoals}
        goalOpen={goalOpen}
        setGoalOpen={setGoalOpen}
        removeGoal={removeGoal}
        addGoal={addGoal}
      />

      <Separator className="my-4" />

      <ProjectWorkspacesSection
        workspaces={workspaces}
        workspaceMode={workspaceMode}
        setWorkspaceMode={setWorkspaceMode}
        workspaceCwd={workspaceCwd}
        setWorkspaceCwd={setWorkspaceCwd}
        workspaceRepoUrl={workspaceRepoUrl}
        setWorkspaceRepoUrl={setWorkspaceRepoUrl}
        workspaceError={workspaceError}
        setWorkspaceError={setWorkspaceError}
        createWorkspace={createWorkspace}
        removeWorkspace={removeWorkspace}
        updateWorkspace={updateWorkspace}
        submitLocalWorkspace={submitLocalWorkspace}
        submitRepoWorkspace={submitRepoWorkspace}
        clearLocalWorkspace={clearLocalWorkspace}
        clearRepoWorkspace={clearRepoWorkspace}
      />

      {SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI && (
        <ProjectExecutionWorkspaceSection
          canEdit={canEdit}
          fieldState={fieldState}
          commitField={commitField}
          executionWorkspacesEnabled={executionWorkspacesEnabled}
          executionWorkspaceDefaultMode={executionWorkspaceDefaultMode}
          executionWorkspaceStrategy={executionWorkspaceStrategy}
          executionWorkspaceAdvancedOpen={executionWorkspaceAdvancedOpen}
          setExecutionWorkspaceAdvancedOpen={setExecutionWorkspaceAdvancedOpen}
          updateExecutionWorkspacePolicy={updateExecutionWorkspacePolicy}
        />
      )}
    </div>
  );
}
