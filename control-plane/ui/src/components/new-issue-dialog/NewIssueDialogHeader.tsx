import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { getContrastTextColor } from "./new-issue-draft";

type CompanyLike = {
  id: string;
  name: string;
  status?: string;
  brandColor?: string | null;
};

export function NewIssueDialogHeader({
  companies,
  dialogCompany,
  effectiveCompanyId,
  companyOpen,
  setCompanyOpen,
  onCompanyChange,
  expanded,
  setExpanded,
  createPending,
  onClose,
}: {
  companies: CompanyLike[];
  dialogCompany: CompanyLike | undefined | null;
  effectiveCompanyId: string | null;
  companyOpen: boolean;
  setCompanyOpen: (open: boolean) => void;
  onCompanyChange: (companyId: string) => void;
  expanded: boolean;
  setExpanded: (value: boolean | ((prev: boolean) => boolean)) => void;
  createPending: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
          <PopoverTrigger asChild>
            <button
              className={cn(
                "px-1.5 py-0.5 rounded text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity",
                !dialogCompany?.brandColor && "bg-muted",
              )}
              style={
                dialogCompany?.brandColor
                  ? {
                      backgroundColor: dialogCompany.brandColor,
                      color: getContrastTextColor(dialogCompany.brandColor),
                    }
                  : undefined
              }
            >
              {(dialogCompany?.name ?? "").slice(0, 3).toUpperCase()}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="start">
            {companies.filter((c) => c.status !== "archived").map((c) => (
              <button
                key={c.id}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 cursor-pointer",
                  c.id === effectiveCompanyId && "bg-accent",
                )}
                onClick={() => {
                  onCompanyChange(c.id);
                  setCompanyOpen(false);
                }}
              >
                <span
                  className={cn(
                    "px-1 py-0.5 rounded text-[10px] font-semibold leading-none",
                    !c.brandColor && "bg-muted",
                  )}
                  style={
                    c.brandColor
                      ? {
                          backgroundColor: c.brandColor,
                          color: getContrastTextColor(c.brandColor),
                        }
                      : undefined
                  }
                >
                  {c.name.slice(0, 3).toUpperCase()}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <span className="text-muted-foreground/60">&rsaquo;</span>
        <span>New issue</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
          disabled={createPending}
        >
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => onClose()}
          disabled={createPending}
        >
          <span className="text-lg leading-none">&times;</span>
        </Button>
      </div>
    </div>
  );
}
