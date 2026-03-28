import type { RefObject } from "react";
import type { Agent, Department, Project } from "@hive/shared";
import { InlineEntitySelector, type InlineEntityOption } from "../InlineEntitySelector";
import { AgentIcon } from "../AgentIconPicker";
import { trackRecentAssignee } from "../../lib/recent-assignees";

export function NewIssueDialogEntityRow({
  assigneeSelectorRef,
  projectSelectorRef,
  departmentSelectorRef,
  assigneeId,
  setAssigneeId,
  projectId,
  departmentId,
  setDepartmentId,
  assigneeOptions,
  projectOptions,
  departmentOptions,
  agents,
  orderedProjects,
  departments,
  currentAssignee,
  currentProject,
  currentDepartment,
  onProjectChange,
  descriptionEditorRef,
}: {
  assigneeSelectorRef: RefObject<HTMLButtonElement | null>;
  projectSelectorRef: RefObject<HTMLButtonElement | null>;
  departmentSelectorRef: RefObject<HTMLButtonElement | null>;
  assigneeId: string;
  setAssigneeId: (id: string) => void;
  projectId: string;
  departmentId: string;
  setDepartmentId: (id: string) => void;
  assigneeOptions: InlineEntityOption[];
  projectOptions: InlineEntityOption[];
  departmentOptions: InlineEntityOption[];
  agents: Agent[] | undefined;
  orderedProjects: Project[];
  departments: Department[] | undefined;
  currentAssignee: Agent | undefined;
  currentProject: Project | undefined;
  currentDepartment: Department | undefined;
  onProjectChange: (nextProjectId: string) => void;
  descriptionEditorRef: RefObject<{ focus: () => void } | null>;
}) {
  return (
    <div className="px-4 pb-2 shrink-0">
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
          <span>For</span>
          <InlineEntitySelector
            ref={assigneeSelectorRef}
            value={assigneeId}
            options={assigneeOptions}
            placeholder="Assignee"
            disablePortal
            noneLabel="No assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees found."
            onChange={(id) => {
              if (id) trackRecentAssignee(id);
              setAssigneeId(id);
            }}
            onConfirm={() => {
              projectSelectorRef.current?.focus();
            }}
            renderTriggerValue={(option) =>
              option && currentAssignee ? (
                <>
                  <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Assignee</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const assignee = (agents ?? []).find((agent) => agent.id === option.id);
              return (
                <>
                  <AgentIcon icon={assignee?.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
          <span>in</span>
          <InlineEntitySelector
            ref={projectSelectorRef}
            value={projectId}
            options={projectOptions}
            placeholder="Project"
            disablePortal
            noneLabel="No project"
            searchPlaceholder="Search projects..."
            emptyMessage="No projects found."
            onChange={onProjectChange}
            onConfirm={() => {
              departmentSelectorRef.current?.focus();
            }}
            renderTriggerValue={(option) =>
              option && currentProject ? (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: currentProject.color ?? "#6366f1" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Project</span>
              )
            }
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const project = orderedProjects.find((item) => item.id === option.id);
              return (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: project?.color ?? "#6366f1" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
          <span>for</span>
          <InlineEntitySelector
            ref={departmentSelectorRef}
            value={departmentId}
            options={departmentOptions}
            placeholder="Department"
            disablePortal
            noneLabel="No department"
            searchPlaceholder="Search departments..."
            emptyMessage="No departments found."
            onChange={setDepartmentId}
            onConfirm={() => {
              descriptionEditorRef.current?.focus();
            }}
            renderTriggerValue={(option) =>
              option && currentDepartment ? (
                <span className="truncate">{option.label}</span>
              ) : (
                <span className="text-muted-foreground">Department</span>
              )
            }
            renderOption={(option) => <span className="truncate">{option.label}</span>}
          />
        </div>
      </div>
    </div>
  );
}
