import type { Dispatch, SetStateAction } from "react";
import type { ExecutionWorkspaceStrategy } from "@hive/shared";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../../lib/utils";
import { DraftInput } from "../agent-config-primitives";
import type { ProjectConfigFieldKey, ProjectFieldSaveState } from "./project-properties-types";
import { SaveIndicator } from "./project-properties-ui-primitives";

export function ProjectExecutionWorkspaceSection({
  canEdit,
  fieldState,
  commitField,
  executionWorkspacesEnabled,
  executionWorkspaceDefaultMode,
  executionWorkspaceStrategy,
  executionWorkspaceAdvancedOpen,
  setExecutionWorkspaceAdvancedOpen,
  updateExecutionWorkspacePolicy,
}: {
  canEdit: boolean;
  fieldState: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  commitField: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  executionWorkspacesEnabled: boolean;
  executionWorkspaceDefaultMode: "isolated" | "project_primary";
  executionWorkspaceStrategy: ExecutionWorkspaceStrategy;
  executionWorkspaceAdvancedOpen: boolean;
  setExecutionWorkspaceAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  updateExecutionWorkspacePolicy: (patch: Record<string, unknown>) => Record<string, unknown> | undefined;
}) {
  return (
    <>
      <Separator className="my-4" />
      <div className="py-1.5 space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Execution Workspaces</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                aria-label="Execution workspaces help"
              >
                ?
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Project-owned defaults for isolated issue checkouts and execution workspace behavior.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>Enable isolated issue checkouts</span>
                <SaveIndicator state={fieldState("execution_workspace_enabled")} />
              </div>
              <div className="text-xs text-muted-foreground">
                Let issues choose between the project’s primary checkout and an isolated execution workspace.
              </div>
            </div>
            {canEdit ? (
              <button
                className={cn(
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                  executionWorkspacesEnabled ? "bg-green-600" : "bg-muted",
                )}
                type="button"
                onClick={() =>
                  commitField(
                    "execution_workspace_enabled",
                    updateExecutionWorkspacePolicy({ enabled: !executionWorkspacesEnabled })!,
                  )}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                    executionWorkspacesEnabled ? "translate-x-4.5" : "translate-x-0.5",
                  )}
                />
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {executionWorkspacesEnabled ? "Enabled" : "Disabled"}
              </span>
            )}
          </div>

          {executionWorkspacesEnabled && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span>New issues default to isolated checkout</span>
                    <SaveIndicator state={fieldState("execution_workspace_default_mode")} />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    If disabled, new issues stay on the project’s primary checkout unless someone opts in.
                  </div>
                </div>
                <button
                  className={cn(
                    "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                    executionWorkspaceDefaultMode === "isolated" ? "bg-green-600" : "bg-muted",
                  )}
                  type="button"
                  onClick={() =>
                    commitField(
                      "execution_workspace_default_mode",
                      updateExecutionWorkspacePolicy({
                        defaultMode: executionWorkspaceDefaultMode === "isolated" ? "project_primary" : "isolated",
                      })!,
                    )}
                >
                  <span
                    className={cn(
                      "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                      executionWorkspaceDefaultMode === "isolated" ? "translate-x-4.5" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>

              <div className="border-t border-border/60 pt-2">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setExecutionWorkspaceAdvancedOpen((open) => !open)}
                >
                  {executionWorkspaceAdvancedOpen
                    ? "Hide advanced checkout settings"
                    : "Show advanced checkout settings"}
                </button>
              </div>

              {executionWorkspaceAdvancedOpen && (
                <div className="space-y-3">
                  <div className="text-xs text-muted-foreground">
                    Host-managed implementation: <span className="text-foreground">Git worktree</span>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Base ref</span>
                        <SaveIndicator state={fieldState("execution_workspace_base_ref")} />
                      </label>
                    </div>
                    <DraftInput
                      value={executionWorkspaceStrategy.baseRef ?? ""}
                      onCommit={(value) =>
                        commitField("execution_workspace_base_ref", {
                          ...updateExecutionWorkspacePolicy({
                            workspaceStrategy: {
                              ...executionWorkspaceStrategy,
                              type: "git_worktree",
                              baseRef: value || null,
                            },
                          })!,
                        })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="origin/main"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Branch template</span>
                        <SaveIndicator state={fieldState("execution_workspace_branch_template")} />
                      </label>
                    </div>
                    <DraftInput
                      value={executionWorkspaceStrategy.branchTemplate ?? ""}
                      onCommit={(value) =>
                        commitField("execution_workspace_branch_template", {
                          ...updateExecutionWorkspacePolicy({
                            workspaceStrategy: {
                              ...executionWorkspaceStrategy,
                              type: "git_worktree",
                              branchTemplate: value || null,
                            },
                          })!,
                        })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="{{issue.identifier}}-{{slug}}"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Worktree parent dir</span>
                        <SaveIndicator state={fieldState("execution_workspace_worktree_parent_dir")} />
                      </label>
                    </div>
                    <DraftInput
                      value={executionWorkspaceStrategy.worktreeParentDir ?? ""}
                      onCommit={(value) =>
                        commitField("execution_workspace_worktree_parent_dir", {
                          ...updateExecutionWorkspacePolicy({
                            workspaceStrategy: {
                              ...executionWorkspaceStrategy,
                              type: "git_worktree",
                              worktreeParentDir: value || null,
                            },
                          })!,
                        })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder=".hive/worktrees"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Provision command</span>
                        <SaveIndicator state={fieldState("execution_workspace_provision_command")} />
                      </label>
                    </div>
                    <DraftInput
                      value={executionWorkspaceStrategy.provisionCommand ?? ""}
                      onCommit={(value) =>
                        commitField("execution_workspace_provision_command", {
                          ...updateExecutionWorkspacePolicy({
                            workspaceStrategy: {
                              ...executionWorkspaceStrategy,
                              type: "git_worktree",
                              provisionCommand: value || null,
                            },
                          })!,
                        })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="bash ./scripts/provision-worktree.sh"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Teardown command</span>
                        <SaveIndicator state={fieldState("execution_workspace_teardown_command")} />
                      </label>
                    </div>
                    <DraftInput
                      value={executionWorkspaceStrategy.teardownCommand ?? ""}
                      onCommit={(value) =>
                        commitField("execution_workspace_teardown_command", {
                          ...updateExecutionWorkspacePolicy({
                            workspaceStrategy: {
                              ...executionWorkspaceStrategy,
                              type: "git_worktree",
                              teardownCommand: value || null,
                            },
                          })!,
                        })}
                      immediate
                      className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                      placeholder="bash ./scripts/teardown-worktree.sh"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Provision runs inside the derived worktree before agent execution. Teardown is stored here for
                    future cleanup flows.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
