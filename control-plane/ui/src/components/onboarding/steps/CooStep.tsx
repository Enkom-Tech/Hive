import { Bot, HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CooStepProps = {
  name: string;
  focusText: string;
  onNameChange: (v: string) => void;
  onFocusChange: (v: string) => void;
};

export function CooStep({
  name,
  focusText,
  onNameChange,
  onFocusChange,
}: CooStepProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-5">
        <div className="flex items-center gap-3 mb-1">
          <div className="bg-muted/50 p-2">
            <Bot className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-medium">
              Your{" "}
              <Tooltip>
                <TooltipTrigger className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 cursor-help">
                  COO
                  <HelpCircle className="h-3 w-3" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <p>Chief Operating Officer agent — the main orchestrator that delegates work to other agents.</p>
                </TooltipContent>
              </Tooltip>{" "}
              agent
            </h3>
            <p className="text-xs text-muted-foreground">
              This agent orchestrates work across workers and other agents according to your company mission.
            </p>
          </div>
        </div>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Name</label>
        <input
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          placeholder="COO"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          autoFocus
        />
      </div>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block">
          What should this COO emphasize? (optional)
        </label>
        <textarea
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[80px]"
          placeholder="Defaults to your company mission; narrow or extend it here."
          value={focusText}
          onChange={(e) => onFocusChange(e.target.value)}
        />
        </div>
      </div>
    </TooltipProvider>
  );
}
