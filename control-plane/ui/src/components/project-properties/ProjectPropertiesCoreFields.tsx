import { Link } from "@/lib/router";
import type { Project } from "@hive/shared";
import { StatusBadge } from "../StatusBadge";
import { formatDate } from "../../lib/utils";
import { DraftInput } from "../agent-config-primitives";
import { InlineEditor } from "../InlineEditor";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X } from "lucide-react";
import type { ProjectConfigFieldKey, ProjectFieldSaveState } from "./project-properties-types";
import { FieldLabel, PropertyRow, ProjectStatusPicker } from "./project-properties-ui-primitives";

type GoalLike = { id: string; title: string };

export function ProjectPropertiesCoreFields({
  project,
  canEdit,
  fieldState,
  commitField,
  linkedGoals,
  availableGoals,
  goalOpen,
  setGoalOpen,
  removeGoal,
  addGoal,
}: {
  project: Project;
  canEdit: boolean;
  fieldState: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  commitField: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  linkedGoals: GoalLike[];
  availableGoals: GoalLike[];
  goalOpen: boolean;
  setGoalOpen: (open: boolean) => void;
  removeGoal: (goalId: string) => void;
  addGoal: (goalId: string) => void;
}) {
  return (
    <div className="space-y-1 pb-4">
      <PropertyRow label={<FieldLabel label="Name" state={fieldState("name")} />}>
        {canEdit ? (
          <DraftInput
            value={project.name}
            onCommit={(name) => commitField("name", { name })}
            immediate
            className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none"
            placeholder="Project name"
          />
        ) : (
          <span className="text-sm">{project.name}</span>
        )}
      </PropertyRow>
      <PropertyRow
        label={<FieldLabel label="Description" state={fieldState("description")} />}
        alignStart
        valueClassName="space-y-0.5"
      >
        {canEdit ? (
          <InlineEditor
            value={project.description ?? ""}
            onSave={(description) => commitField("description", { description })}
            as="p"
            className="text-sm text-muted-foreground"
            placeholder="Add a description..."
            multiline
          />
        ) : (
          <p className="text-sm text-muted-foreground">{project.description?.trim() || "No description"}</p>
        )}
      </PropertyRow>
      <PropertyRow label={<FieldLabel label="Status" state={fieldState("status")} />}>
        {canEdit ? (
          <ProjectStatusPicker status={project.status} onChange={(status) => commitField("status", { status })} />
        ) : (
          <StatusBadge status={project.status} />
        )}
      </PropertyRow>
      {project.leadAgentId && (
        <PropertyRow label="Lead">
          <span className="text-sm font-mono">{project.leadAgentId.slice(0, 8)}</span>
        </PropertyRow>
      )}
      <PropertyRow
        label={<FieldLabel label="Goals" state={fieldState("goals")} />}
        alignStart
        valueClassName="space-y-2"
      >
        {linkedGoals.length === 0 ? (
          <span className="text-sm text-muted-foreground">None</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {linkedGoals.map((goal) => (
              <span
                key={goal.id}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
              >
                <Link to={`/goals/${goal.id}`} className="hover:underline max-w-[220px] truncate">
                  {goal.title}
                </Link>
                {canEdit && (
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    type="button"
                    onClick={() => removeGoal(goal.id)}
                    aria-label={`Remove goal ${goal.title}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {canEdit && (
          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="xs" className="h-6 w-fit px-2" disabled={availableGoals.length === 0}>
                <Plus className="h-3 w-3 mr-1" />
                Goal
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {availableGoals.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">All goals linked.</div>
              ) : (
                availableGoals.map((goal) => (
                  <button
                    key={goal.id}
                    className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                    onClick={() => addGoal(goal.id)}
                  >
                    {goal.title}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
        )}
      </PropertyRow>
      <PropertyRow label={<FieldLabel label="Created" state="idle" />}>
        <span className="text-sm">{formatDate(project.createdAt)}</span>
      </PropertyRow>
      <PropertyRow label={<FieldLabel label="Updated" state="idle" />}>
        <span className="text-sm">{formatDate(project.updatedAt)}</span>
      </PropertyRow>
      {project.targetDate && (
        <PropertyRow label={<FieldLabel label="Target Date" state="idle" />}>
          <span className="text-sm">{formatDate(project.targetDate)}</span>
        </PropertyRow>
      )}
    </div>
  );
}
