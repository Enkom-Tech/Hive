import type { UseMutationResult } from "@tanstack/react-query";
import type { Project } from "@hive/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, FolderGit, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { ChoosePathButton } from "../PathInstructionsModal";
import { REPO_ONLY_CWD_SENTINEL } from "./project-properties-types";
import { formatGitHubRepo } from "./project-properties-workspace-utils";

type Workspace = Project["workspaces"][number];

export function ProjectWorkspacesSection({
  workspaces,
  workspaceMode,
  setWorkspaceMode,
  workspaceCwd,
  setWorkspaceCwd,
  workspaceRepoUrl,
  setWorkspaceRepoUrl,
  workspaceError,
  setWorkspaceError,
  createWorkspace,
  removeWorkspace,
  updateWorkspace,
  submitLocalWorkspace,
  submitRepoWorkspace,
  clearLocalWorkspace,
  clearRepoWorkspace,
}: {
  workspaces: Project["workspaces"];
  workspaceMode: "local" | "repo" | null;
  setWorkspaceMode: (mode: "local" | "repo" | null) => void;
  workspaceCwd: string;
  setWorkspaceCwd: (v: string) => void;
  workspaceRepoUrl: string;
  setWorkspaceRepoUrl: (v: string) => void;
  workspaceError: string | null;
  setWorkspaceError: (v: string | null) => void;
  createWorkspace: UseMutationResult<unknown, Error, Record<string, unknown>, unknown>;
  removeWorkspace: UseMutationResult<unknown, Error, string, unknown>;
  updateWorkspace: UseMutationResult<unknown, Error, { workspaceId: string; data: Record<string, unknown> }, unknown>;
  submitLocalWorkspace: () => void;
  submitRepoWorkspace: () => void;
  clearLocalWorkspace: (workspace: Workspace) => void;
  clearRepoWorkspace: (workspace: Workspace) => void;
}) {
  return (
    <div className="space-y-1 py-4">
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Workspaces</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                aria-label="Workspaces help"
              >
                ?
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Workspaces give your agents hints about where the work is</TooltipContent>
          </Tooltip>
        </div>
        {workspaces.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No workspace configured.
          </p>
        ) : (
          <div className="space-y-1">
            {workspaces.map((workspace) => (
              <div key={workspace.id} className="space-y-1">
                {workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL ? (
                  <div className="flex items-center justify-between gap-2 py-1">
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{workspace.cwd}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => clearLocalWorkspace(workspace)}
                      aria-label="Delete local folder"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
                {workspace.repoUrl ? (
                  <div className="flex items-center justify-between gap-2 py-1">
                    <a
                      href={workspace.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
                    >
                      <FolderGit className="h-3 w-3 shrink-0" />
                      <span className="truncate">{formatGitHubRepo(workspace.repoUrl)}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => clearRepoWorkspace(workspace)}
                      aria-label="Delete workspace repo"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
                {workspace.runtimeServices && workspace.runtimeServices.length > 0 ? (
                  <div className="space-y-1 pl-2">
                    {workspace.runtimeServices.map((service) => (
                      <div
                        key={service.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium">{service.serviceName}</span>
                            <span
                              className={cn(
                                "rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                                service.status === "running"
                                  ? "bg-green-500/15 text-green-700 dark:text-green-300"
                                  : service.status === "failed"
                                    ? "bg-red-500/15 text-red-700 dark:text-red-300"
                                    : "bg-muted text-muted-foreground",
                              )}
                            >
                              {service.status}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {service.url ? (
                              <a
                                href={service.url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-foreground hover:underline"
                              >
                                {service.url}
                              </a>
                            ) : (
                              service.command ?? "No URL"
                            )}
                          </div>
                        </div>
                        <div className="text-[10px] text-muted-foreground whitespace-nowrap">{service.lifecycle}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-col items-start gap-2">
          <Button
            variant="outline"
            size="xs"
            className="h-7 px-2.5"
            onClick={() => {
              setWorkspaceMode("local");
              setWorkspaceError(null);
            }}
          >
            Add workspace local folder
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="h-7 px-2.5"
            onClick={() => {
              setWorkspaceMode("repo");
              setWorkspaceError(null);
            }}
          >
            Add workspace repo
          </Button>
        </div>
        {workspaceMode === "local" && (
          <div className="space-y-1.5 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                value={workspaceCwd}
                onChange={(e) => setWorkspaceCwd(e.target.value)}
                placeholder="/absolute/path/to/workspace"
              />
              <ChoosePathButton />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                className="h-6 px-2"
                disabled={!workspaceCwd.trim() || createWorkspace.isPending}
                onClick={submitLocalWorkspace}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-2"
                onClick={() => {
                  setWorkspaceMode(null);
                  setWorkspaceCwd("");
                  setWorkspaceError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {workspaceMode === "repo" && (
          <div className="space-y-1.5 rounded-md border border-border p-2">
            <input
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
              value={workspaceRepoUrl}
              onChange={(e) => setWorkspaceRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                className="h-6 px-2"
                disabled={!workspaceRepoUrl.trim() || createWorkspace.isPending}
                onClick={submitRepoWorkspace}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-2"
                onClick={() => {
                  setWorkspaceMode(null);
                  setWorkspaceRepoUrl("");
                  setWorkspaceError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {workspaceError && <p className="text-xs text-destructive">{workspaceError}</p>}
        {createWorkspace.isError && <p className="text-xs text-destructive">Failed to save workspace.</p>}
        {removeWorkspace.isError && <p className="text-xs text-destructive">Failed to delete workspace.</p>}
        {updateWorkspace.isError && <p className="text-xs text-destructive">Failed to update workspace.</p>}
      </div>
    </div>
  );
}
