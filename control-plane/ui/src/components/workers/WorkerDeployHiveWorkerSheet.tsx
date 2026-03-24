import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { WorkerDownloadArtifact, WorkerDownloadsResponse } from "@/api/worker-downloads";
import { DeployHiveWorkerGuideContent } from "./WorkerDeploymentGuide";
import { WorkerQuickInstallCard } from "./WorkerQuickInstallCard";
import { WorkerDroneBootstrapSection } from "./WorkerDroneBootstrapSection";
import { WorkerDeliveryBusHint } from "./WorkerDeliveryBusHint";

export type WorkerDeployHiveWorkerSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  apiBase: string;
  workerBinHint: string;
  downloads: WorkerDownloadsResponse | undefined;
  isLoading: boolean;
  suggested: WorkerDownloadArtifact | null;
};

/**
 * Single sheet: deploy paths, binary install, and drone-first bootstrap (Workers page entry).
 */
export function WorkerDeployHiveWorkerSheet({
  open,
  onOpenChange,
  companyId,
  apiBase,
  workerBinHint,
  downloads,
  isLoading,
  suggested,
}: WorkerDeployHiveWorkerSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl"
        aria-labelledby="deploy-hive-worker-sheet-title"
      >
        <SheetHeader className="shrink-0 space-y-1 border-b border-border px-4 py-4 text-left">
          <SheetTitle id="deploy-hive-worker-sheet-title">Deploy hive-worker</SheetTitle>
          <SheetDescription>
            Follow the steps: substrate → binary → credentials → verify. Then use <strong className="text-foreground">Assign to drone</strong> on a board identity
            on Workers so <code className="font-mono text-[11px]">hive-worker</code> connects as that identity.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 p-4 pb-8">
            <WorkerDeliveryBusHint workerDeliveryBusConfigured={downloads?.workerDeliveryBusConfigured} />

            <section className="space-y-2" aria-labelledby="deploy-step-substrate">
              <h2 id="deploy-step-substrate" className="text-sm font-semibold text-foreground">
                <span className="text-muted-foreground">1 ·</span> Choose substrate
              </h2>
              <div className="rounded-lg border border-border bg-card p-4">
                <DeployHiveWorkerGuideContent hideTitleAndIntro />
              </div>
            </section>

            <section className="space-y-2" aria-labelledby="deploy-step-artifact">
              <h2 id="deploy-step-artifact" className="text-sm font-semibold text-foreground">
                <span className="text-muted-foreground">2 ·</span> Get the binary
              </h2>
              <WorkerQuickInstallCard
                sectionId="worker-binary-install"
                downloads={downloads}
                isLoading={isLoading}
                suggested={suggested}
              />
            </section>

            <section className="space-y-2" aria-labelledby="deploy-step-credentials">
              <h2 id="deploy-step-credentials" className="text-sm font-semibold text-foreground">
                <span className="text-muted-foreground">3 ·</span> Credentials and bootstrap
              </h2>
              <WorkerDroneBootstrapSection companyId={companyId} apiBase={apiBase} workerBinHint={workerBinHint} />
            </section>

            <section className="space-y-2" aria-labelledby="deploy-step-verify">
              <h2 id="deploy-step-verify" className="text-sm font-semibold text-foreground">
                <span className="text-muted-foreground">4 ·</span> Verify
              </h2>
              <div className="rounded-lg border border-border bg-muted/15 p-4 text-xs text-muted-foreground space-y-2">
                <p>
                  On the machine running <code className="font-mono text-[11px]">hive-worker</code>,{" "}
                  <code className="font-mono text-[11px]">GET /health</code> on port{" "}
                  <code className="font-mono text-[11px]">8080</code> (or your{" "}
                  <code className="font-mono text-[11px]">HIVE_WORKER_HTTP_ADDR</code>) should return OK.
                </p>
                <p>
                  On the <strong className="text-foreground">Workers</strong> page, use{" "}
                  <strong className="text-foreground">Assign to drone</strong> on a board identity row to mint tokens and
                  confirm <strong className="text-foreground">connected</strong> when the drone is linked (
                  <span className="text-foreground">best-effort</span> per API instance — see API docs).
                </p>
              </div>
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
