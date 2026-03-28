import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { departmentsApi } from "../api/departments";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency } from "../lib/recent-assignees";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "../lib/utils";
import type { IssueStatus } from "@hive/shared";
import { ISSUE_STATUS_TODO } from "@hive/shared";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import type { InlineEntityOption } from "./InlineEntitySelector";
import {
  NEW_ISSUE_DRAFT_DEBOUNCE_MS,
  clearNewIssueDraft,
  loadNewIssueDraft,
  saveNewIssueDraft,
  type NewIssueDraft,
} from "./new-issue-dialog/new-issue-draft";
import {
  SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI,
  newIssueDialogRequiresQualityReviewOptions,
} from "./new-issue-dialog/new-issue-dialog-constants";
import { NewIssueDialogHeader } from "./new-issue-dialog/NewIssueDialogHeader";
import { NewIssueDialogEntityRow } from "./new-issue-dialog/NewIssueDialogEntityRow";
import { NewIssueDialogExecutionWorkspaceToggle } from "./new-issue-dialog/NewIssueDialogExecutionWorkspaceToggle";
import { NewIssueDialogPropertyChips } from "./new-issue-dialog/NewIssueDialogPropertyChips";
import { NewIssueDialogFooter } from "./new-issue-dialog/NewIssueDialogFooter";

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState(ISSUE_STATUS_TODO);
  const [priority, setPriority] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [useIsolatedExecutionWorkspace, setUseIsolatedExecutionWorkspace] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [requiresQualityReviewOption, setRequiresQualityReviewOption] = useState<"default" | "yes" | "no">(
    "default",
  );
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executionWorkspaceDefaultProjectId = useRef<string | null>(null);

  const effectiveCompanyId = dialogCompanyId ?? selectedCompanyId;
  const dialogCompany = companies.find((c) => c.id === effectiveCompanyId) ?? selectedCompany;

  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const departmentSelectorRef = useRef<HTMLButtonElement | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(effectiveCompanyId!),
    queryFn: () => agentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(effectiveCompanyId!),
    queryFn: () => projectsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: departments } = useQuery({
    queryKey: queryKeys.departments.list(effectiveCompanyId!),
    queryFn: () => departmentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: effectiveCompanyId,
    userId: currentUserId,
  });

  const supportsAssigneeOverrides = false;
  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const createIssue = useMutation({
    mutationFn: ({ companyId, ...data }: { companyId: string } & Record<string, unknown>) =>
      issuesApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(effectiveCompanyId!) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      clearNewIssueDraft();
      reset();
      closeNewIssue();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!effectiveCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
    },
  });

  const scheduleSave = useCallback((draft: NewIssueDraft) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (draft.title.trim()) saveNewIssueDraft(draft);
    }, NEW_ISSUE_DRAFT_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    if (!newIssueOpen) return;
    scheduleSave({
      title,
      description,
      status,
      priority,
      assigneeId,
      projectId,
      departmentId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      useIsolatedExecutionWorkspace,
    });
  }, [
    title,
    description,
    status,
    priority,
    assigneeId,
    projectId,
    departmentId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    useIsolatedExecutionWorkspace,
    newIssueOpen,
    scheduleSave,
  ]);

  useEffect(() => {
    if (!newIssueOpen) return;
    setDialogCompanyId(selectedCompanyId);
    executionWorkspaceDefaultProjectId.current = null;

    const draft = loadNewIssueDraft();
    if (newIssueDefaults.title) {
      setTitle(newIssueDefaults.title);
      setDescription(newIssueDefaults.description ?? "");
      setStatus((newIssueDefaults.status ?? ISSUE_STATUS_TODO) as IssueStatus);
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(newIssueDefaults.projectId ?? "");
      setDepartmentId("");
      setAssigneeId(newIssueDefaults.assigneeAgentId ?? "");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setUseIsolatedExecutionWorkspace(false);
    } else if (draft && draft.title.trim()) {
      setTitle(draft.title);
      setDescription(draft.description);
      setStatus((draft.status || ISSUE_STATUS_TODO) as IssueStatus);
      setPriority(draft.priority);
      setAssigneeId(newIssueDefaults.assigneeAgentId ?? draft.assigneeId);
      setProjectId(newIssueDefaults.projectId ?? draft.projectId);
      setDepartmentId(draft.departmentId ?? "");
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setUseIsolatedExecutionWorkspace(draft.useIsolatedExecutionWorkspace ?? false);
    } else {
      setStatus((newIssueDefaults.status ?? ISSUE_STATUS_TODO) as IssueStatus);
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(newIssueDefaults.projectId ?? "");
      setDepartmentId("");
      setAssigneeId(newIssueDefaults.assigneeAgentId ?? "");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setUseIsolatedExecutionWorkspace(false);
    }
  }, [newIssueOpen, newIssueDefaults]);

  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
    }
  }, [supportsAssigneeOverrides]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setTitle("");
    setDescription("");
    setStatus(ISSUE_STATUS_TODO);
    setPriority("");
    setAssigneeId("");
    setProjectId("");
    setDepartmentId("");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setUseIsolatedExecutionWorkspace(false);
    setExpanded(false);
    setDialogCompanyId(null);
    setCompanyOpen(false);
    executionWorkspaceDefaultProjectId.current = null;
  }

  function handleCompanyChange(companyId: string) {
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setAssigneeId("");
    setProjectId("");
    setDepartmentId("");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setUseIsolatedExecutionWorkspace(false);
  }

  function discardDraft() {
    clearNewIssueDraft();
    reset();
    closeNewIssue();
  }

  function handleSubmit() {
    if (!effectiveCompanyId || !title.trim() || createIssue.isPending) return;
    const requiresQualityReview =
      newIssueDialogRequiresQualityReviewOptions.find((o) => o.value === requiresQualityReviewOption)?.payload ??
      null;
    const selectedProject = orderedProjects.find((project) => project.id === projectId);
    const executionWorkspacePolicy = SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI
      ? selectedProject?.executionWorkspacePolicy
      : null;
    const executionWorkspaceSettings = executionWorkspacePolicy?.enabled
      ? {
          mode: useIsolatedExecutionWorkspace ? "isolated" : "project_primary",
        }
      : null;
    createIssue.mutate({
      companyId: effectiveCompanyId,
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority: priority || "medium",
      ...(assigneeId ? { assigneeAgentId: assigneeId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(departmentId ? { departmentId } : {}),
      requiresQualityReview,
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleAttachImage(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const asset = await uploadDescriptionImage.mutateAsync(file);
      const name = file.name || "image";
      setDescription((prev) => {
        const suffix = `![${name}](${asset.contentPath})`;
        return prev ? `${prev}\n\n${suffix}` : suffix;
      });
    } finally {
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const hasDraft = title.trim().length > 0 || description.trim().length > 0;
  const currentAssignee = (agents ?? []).find((a) => a.id === assigneeId);
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const currentDepartment = (departments ?? []).find((department) => department.id === departmentId);
  const currentProjectExecutionWorkspacePolicy = SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI
    ? currentProject?.executionWorkspacePolicy ?? null
    : null;
  const currentProjectSupportsExecutionWorkspace = Boolean(currentProjectExecutionWorkspacePolicy?.enabled);
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const departmentOptions = useMemo<InlineEntityOption[]>(
    () =>
      (departments ?? []).map((department) => ({
        id: department.id,
        label: department.name,
        searchText: `${department.name} ${department.slug}`,
      })),
    [departments],
  );
  const savedDraft = loadNewIssueDraft();
  const hasSavedDraft = Boolean(savedDraft?.title.trim() || savedDraft?.description.trim());
  const canDiscardDraft = hasDraft || hasSavedDraft;
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : "Failed to create issue. Try again.";

  const handleProjectChange = useCallback(
    (nextProjectId: string) => {
      setProjectId(nextProjectId);
      const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
      const policy = SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI ? nextProject?.executionWorkspacePolicy : null;
      executionWorkspaceDefaultProjectId.current = nextProjectId || null;
      setUseIsolatedExecutionWorkspace(Boolean(policy?.enabled && policy.defaultMode === "isolated"));
    },
    [orderedProjects],
  );

  useEffect(() => {
    if (!newIssueOpen || !projectId || executionWorkspaceDefaultProjectId.current === projectId) {
      return;
    }
    const project = orderedProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    executionWorkspaceDefaultProjectId.current = projectId;
    setUseIsolatedExecutionWorkspace(
      Boolean(
        SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI &&
          project.executionWorkspacePolicy?.enabled &&
          project.executionWorkspacePolicy.defaultMode === "isolated",
      ),
    );
  }, [newIssueOpen, orderedProjects, projectId]);

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)]",
          expanded ? "sm:max-w-2xl h-[calc(100dvh-2rem)]" : "sm:max-w-lg",
        )}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
            return;
          }
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper]")) {
            event.preventDefault();
          }
        }}
      >
        <NewIssueDialogHeader
          companies={companies}
          dialogCompany={dialogCompany}
          effectiveCompanyId={effectiveCompanyId}
          companyOpen={companyOpen}
          setCompanyOpen={setCompanyOpen}
          onCompanyChange={handleCompanyChange}
          expanded={expanded}
          setExpanded={setExpanded}
          createPending={createIssue.isPending}
          onClose={closeNewIssue}
        />

        <div className="px-4 pt-4 pb-2 shrink-0">
          <textarea
            className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50"
            placeholder="Issue title"
            rows={1}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            readOnly={createIssue.isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                assigneeSelectorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        <NewIssueDialogEntityRow
          assigneeSelectorRef={assigneeSelectorRef}
          projectSelectorRef={projectSelectorRef}
          departmentSelectorRef={departmentSelectorRef}
          assigneeId={assigneeId}
          setAssigneeId={setAssigneeId}
          projectId={projectId}
          departmentId={departmentId}
          setDepartmentId={setDepartmentId}
          assigneeOptions={assigneeOptions}
          projectOptions={projectOptions}
          departmentOptions={departmentOptions}
          agents={agents}
          orderedProjects={orderedProjects}
          departments={departments}
          currentAssignee={currentAssignee}
          currentProject={currentProject}
          currentDepartment={currentDepartment}
          onProjectChange={handleProjectChange}
          descriptionEditorRef={descriptionEditorRef}
        />

        {currentProjectSupportsExecutionWorkspace && (
          <NewIssueDialogExecutionWorkspaceToggle
            useIsolatedExecutionWorkspace={useIsolatedExecutionWorkspace}
            setUseIsolatedExecutionWorkspace={setUseIsolatedExecutionWorkspace}
          />
        )}

        <div
          className={cn(
            "px-4 pb-2 overflow-y-auto min-h-0 border-t border-border/60 pt-3",
            expanded ? "flex-1" : "",
          )}
        >
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn("text-sm text-muted-foreground pb-12", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <NewIssueDialogPropertyChips
          status={status}
          setStatus={setStatus}
          priority={priority}
          setPriority={setPriority}
          statusOpen={statusOpen}
          setStatusOpen={setStatusOpen}
          priorityOpen={priorityOpen}
          setPriorityOpen={setPriorityOpen}
          moreOpen={moreOpen}
          setMoreOpen={setMoreOpen}
          requiresQualityReviewOption={requiresQualityReviewOption}
          setRequiresQualityReviewOption={setRequiresQualityReviewOption}
          attachInputRef={attachInputRef}
          onAttachImage={handleAttachImage}
          uploadDescriptionImage={uploadDescriptionImage}
        />

        <NewIssueDialogFooter
          title={title}
          createIssue={createIssue}
          createIssueErrorMessage={createIssueErrorMessage}
          canDiscardDraft={canDiscardDraft}
          onDiscardDraft={discardDraft}
          onSubmit={handleSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}
