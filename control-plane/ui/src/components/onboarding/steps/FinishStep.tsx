import { AlertTriangle, Bot, Building2, Check, Radio } from "lucide-react";
import { Link } from "@/lib/router";

type FinishStepProps = {
  companyName: string;
  missionSummary: string;
  workerConnected: boolean;
  workerSkipped: boolean;
  cooName: string | null;
  cooConfigured: boolean;
};

export function FinishStep({
  companyName,
  missionSummary,
  workerConnected,
  workerSkipped,
  cooName,
  cooConfigured,
}: FinishStepProps) {
  const workerWarning = workerSkipped || !workerConnected;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="bg-muted/50 p-2">
          <Check className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-medium">You&apos;re set up</h3>
          <p className="text-xs text-muted-foreground">
            Here&apos;s what you have so far. Next, add more agents and tasks from the dashboard when you&apos;re
            ready.
          </p>
        </div>
      </div>

      <div className="border border-border divide-y divide-border rounded-md overflow-hidden">
        <div className="flex items-start gap-3 px-3 py-2.5">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{companyName || "—"}</p>
            <p className="text-xs text-muted-foreground">Company</p>
            {missionSummary ? (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{missionSummary}</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">No mission captured — add goals from the dashboard anytime.</p>
            )}
          </div>
          <Check className="h-4 w-4 text-green-500 shrink-0" />
        </div>

        <div className="flex items-start gap-3 px-3 py-2.5">
          <Radio className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">COO drone connection</p>
            <p className="text-xs text-muted-foreground">
              {workerSkipped
                ? "Skipped — open Workers and use Assign to drone on the COO row when you’re ready (install binary once, then pair or token as that identity)."
                : workerConnected
                  ? "Connected"
                  : "Not connected yet — open Workers: Binary install, then Assign to drone on the COO board identity (pair or token)."}
            </p>
          </div>
          {workerWarning ? (
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" aria-hidden />
          ) : (
            <Check className="h-4 w-4 text-green-500 shrink-0" />
          )}
        </div>

        <div className="flex items-start gap-3 px-3 py-2.5">
          <Bot className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{cooConfigured && cooName ? cooName : "—"}</p>
            <p className="text-xs text-muted-foreground">COO agent</p>
          </div>
          {cooConfigured ? (
            <Check className="h-4 w-4 text-green-500 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" aria-hidden />
          )}
        </div>
      </div>

      <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
        <li>
          <Link to="/workers" className="text-foreground underline underline-offset-2">
            Workers
          </Link>{" "}
          is the hub for drones and board identities: Binary install, Assign to drone (pair or token), and approvals — anytime, not
          only during onboarding.
        </li>
        <li>Add your first engineer (or other) agent from the board.</li>
        <li>Create a project and a task when you have work ready to assign.</li>
      </ul>
    </div>
  );
}
