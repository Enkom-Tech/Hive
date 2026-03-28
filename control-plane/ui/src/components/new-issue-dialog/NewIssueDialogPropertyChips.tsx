import type { ChangeEvent, RefObject } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar, CircleDot, Hexagon, Minus, MoreHorizontal, Tag } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  newIssueDialogPriorities,
  newIssueDialogRequiresQualityReviewOptions,
  newIssueDialogStatuses,
  type RequiresQualityReviewOptionValue,
} from "./new-issue-dialog-constants";
import type { IssueStatus } from "@hive/shared";

export function NewIssueDialogPropertyChips({
  status,
  setStatus,
  priority,
  setPriority,
  statusOpen,
  setStatusOpen,
  priorityOpen,
  setPriorityOpen,
  moreOpen,
  setMoreOpen,
  requiresQualityReviewOption,
  setRequiresQualityReviewOption,
  attachInputRef,
  onAttachImage,
  uploadDescriptionImage,
}: {
  status: IssueStatus;
  setStatus: (s: IssueStatus) => void;
  priority: string;
  setPriority: (p: string) => void;
  statusOpen: boolean;
  setStatusOpen: (open: boolean) => void;
  priorityOpen: boolean;
  setPriorityOpen: (open: boolean) => void;
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
  requiresQualityReviewOption: RequiresQualityReviewOptionValue;
  setRequiresQualityReviewOption: (v: "default" | "yes" | "no") => void;
  attachInputRef: RefObject<HTMLInputElement | null>;
  onAttachImage: (evt: ChangeEvent<HTMLInputElement>) => void;
  uploadDescriptionImage: UseMutationResult<unknown, Error, File, unknown>;
}) {
  const currentStatus = newIssueDialogStatuses.find((s) => s.value === status) ?? newIssueDialogStatuses[1]!;
  const currentPriority = newIssueDialogPriorities.find((p) => p.value === priority);

  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap shrink-0">
      <Popover open={statusOpen} onOpenChange={setStatusOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors cursor-pointer">
            <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
            {currentStatus.label}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          {newIssueDialogStatuses.map((s) => (
            <button
              key={s.value}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 cursor-pointer",
                s.value === status && "bg-accent",
              )}
              onClick={() => {
                setStatus(s.value as IssueStatus);
                setStatusOpen(false);
              }}
            >
              <CircleDot className={cn("h-3 w-3", s.color)} />
              {s.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors cursor-pointer">
            {currentPriority ? (
              <>
                <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
                {currentPriority.label}
              </>
            ) : (
              <>
                <Minus className="h-3 w-3 text-muted-foreground" />
                Priority
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          {newIssueDialogPriorities.map((p) => (
            <button
              key={p.value}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 cursor-pointer",
                p.value === priority && "bg-accent",
              )}
              onClick={() => {
                setPriority(p.value);
                setPriorityOpen(false);
              }}
            >
              <p.icon className={cn("h-3 w-3", p.color)} />
              {p.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground cursor-pointer">
        <Tag className="h-3 w-3" />
        Labels
      </button>

      <input
        ref={attachInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={onAttachImage}
      />
      <button
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground cursor-pointer"
        onClick={() => attachInputRef.current?.click()}
        disabled={uploadDescriptionImage.isPending}
      >
        <Hexagon className="h-3 w-3" />
        {uploadDescriptionImage.isPending ? "Uploading..." : "Image"}
      </button>

      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center justify-center rounded-md border border-border p-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground cursor-pointer">
            <MoreHorizontal className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-1" align="start">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-b border-border mb-1">
            Require quality review
          </div>
          {newIssueDialogRequiresQualityReviewOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left cursor-pointer",
                requiresQualityReviewOption === opt.value ? "bg-accent/50 text-foreground" : "text-muted-foreground",
              )}
              onClick={() => {
                setRequiresQualityReviewOption(opt.value as "default" | "yes" | "no");
                setMoreOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
          <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground mt-1 cursor-pointer">
            <Calendar className="h-3 w-3" />
            Start date
          </button>
          <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground cursor-pointer">
            <Calendar className="h-3 w-3" />
            Due date
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
