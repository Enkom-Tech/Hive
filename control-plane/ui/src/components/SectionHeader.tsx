import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionHeaderProps {
  icon: ReactNode;
  title: string;
  count?: number;
  trailing?: ReactNode;
  className?: string;
}

/**
 * Grouped-list style section header: icon, title, optional count, optional trailing link/action.
 * Used on Inbox and other list views for consistent section headers.
 */
export function SectionHeader({ icon, title, count, trailing, className }: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md border border-border border-b-0",
        className
      )}
    >
      {icon}
      <span className="text-sm font-medium">{title}</span>
      {count !== undefined && (
        <span className="text-xs text-muted-foreground ml-1">{count}</span>
      )}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </div>
  );
}
