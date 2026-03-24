import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

const metricCardWrapper =
  "relative overflow-hidden rounded-md border border-white/10 bg-white/5 backdrop-blur-xl border-l-[3px] border-l-accent shadow-[0_0_12px_-2px_rgba(var(--accent-rgb),0.15)] h-full transition-colors";

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "h-full px-4 py-4 sm:px-5 sm:py-5 transition-colors",
        isClickable && "cursor-pointer hover:bg-white/5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-accent">
            {value}
          </p>
          <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
            {label}
          </p>
          {description && (
            <div className="text-xs text-muted-foreground/70 mt-1.5 hidden sm:block">{description}</div>
          )}
        </div>
        <Icon className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className={cn(metricCardWrapper, "no-underline text-inherit")} onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className={metricCardWrapper} onClick={onClick}>
        {inner}
      </div>
    );
  }

  return <div className={metricCardWrapper}>{inner}</div>;
}
