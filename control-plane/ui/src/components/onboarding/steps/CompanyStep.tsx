import { useRef } from "react";
import { Building2, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutosizeTextArea } from "../../../hooks/useAutosizeTextArea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CompanyStepProps = {
  companyName: string;
  goalText: string;
  onCompanyNameChange: (v: string) => void;
  onGoalTextChange: (v: string) => void;
  companyAlreadyCreated: boolean;
};

const MISSION_PLACEHOLDER =
  "Optional. Example: Ship a reliable product with clear docs and happy early adopters by Q3.";

export function CompanyStep({
  companyName,
  goalText,
  onCompanyNameChange,
  onGoalTextChange,
  companyAlreadyCreated,
}: CompanyStepProps) {
  const goalRef = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextArea(goalRef, goalText, true);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-5">
        <div className="flex items-center gap-3 mb-1">
          <div className="bg-muted/50 p-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-medium">Company</h3>
            <p className="text-xs text-muted-foreground">
              Name your company. Add an optional mission or high-level goal for your{" "}
              <Tooltip>
                <TooltipTrigger className="inline-flex items-center gap-0.5 text-foreground underline decoration-dotted underline-offset-2 cursor-help">
                  COO
                  <HelpCircle className="h-3 w-3" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <p>Chief Operating Officer agent — orchestrates work across your team of AI agents.</p>
                </TooltipContent>
              </Tooltip>{" "}
              and managers; production agent rules live in company settings.
            </p>
          </div>
        </div>

      <div className="group">
        <label
          className={cn(
            "text-xs mb-1 block transition-colors",
            companyName.trim()
              ? "text-foreground"
              : "text-muted-foreground group-focus-within:text-foreground",
          )}
        >
          Company name
        </label>
        <input
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          placeholder="Acme Corp"
          value={companyName}
          onChange={(e) => onCompanyNameChange(e.target.value)}
          disabled={companyAlreadyCreated}
          autoFocus
        />
      </div>

      <div className="group">
        <label
          className={cn(
            "text-xs mb-1 block font-medium transition-colors",
            goalText.trim() ? "text-foreground" : "text-muted-foreground group-focus-within:text-foreground",
          )}
        >
          Company mission / goal (optional)
        </label>
        <textarea
          ref={goalRef}
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[100px]"
          placeholder={MISSION_PLACEHOLDER}
          value={goalText}
          onChange={(e) => onGoalTextChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1.5">
          Creates a company-level goal when filled. Skip if you want to add goals from the dashboard later.
        </p>
      </div>

        {companyAlreadyCreated && (
          <p className="text-xs text-muted-foreground">
            Company already exists. Continue to connect a worker or adjust your COO.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
