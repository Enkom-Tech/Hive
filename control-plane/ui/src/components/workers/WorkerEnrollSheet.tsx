import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ManagedWorkerRuntimeSection } from "./ManagedWorkerRuntimeSection";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentRouteId: string;
  companyId: string;
  agentName: string;
  /** Opens Deploy hive-worker sheet (Workers page); closes this sheet to avoid stacking. */
  onOpenDeployHiveWorker?: () => void;
};

/**
 * Single canonical surface for install, push pairing, pipe commands, and enrollment tokens (Workers page).
 */
export function WorkerEnrollSheet({
  open,
  onOpenChange,
  agentId,
  agentRouteId,
  companyId,
  agentName,
  onOpenDeployHiveWorker,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl"
        aria-labelledby="worker-enroll-sheet-title"
      >
        <SheetHeader className="shrink-0 space-y-1 border-b border-border px-4 py-4 text-left">
          <SheetTitle id="worker-enroll-sheet-title">Assign board identity to a worker</SheetTitle>
          <SheetDescription>
            <strong className="text-foreground">{agentName}</strong> is a <strong className="text-foreground">board agent identity</strong> (who the scheduler assigns work to). Install{" "}
            <code className="font-mono text-[11px]">hive-worker</code> on a host first (see Workers → Binary install), then use pairing, pipe+pair, or a token below so a running worker process{" "}
            <strong className="text-foreground">connects as this identity</strong> (outbound WebSocket). This does not create the binary or container — it only links an existing drone to this row.
            Coding-agent subprocesses during runs are separate.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4 pb-8">
            <ManagedWorkerRuntimeSection
              agentId={agentId}
              agentRouteId={agentRouteId}
              companyId={companyId}
              heading={`Worker connection — ${agentName}`}
              className="border-0 bg-transparent p-0 shadow-none"
              variant="enrollmentOnly"
              onOpenDeployHiveWorker={onOpenDeployHiveWorker}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
