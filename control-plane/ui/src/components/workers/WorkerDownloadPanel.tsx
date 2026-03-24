import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import {
  workerDownloadsApi,
  type WorkerDownloadArtifact,
  type WorkerDownloadsResponse,
} from "../../api/worker-downloads";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { guessSuggestedWorkerArtifact, workerBinForArtifact } from "@/lib/worker-client-hints";

const STALE_MS = 5 * 60 * 1000;

export function useWorkerDownloadHints() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.workerDownloads,
    queryFn: () => workerDownloadsApi.get(),
    staleTime: STALE_MS,
    retry: 1,
  });

  const suggested = useMemo(() => guessSuggestedWorkerArtifact(data?.artifacts ?? []), [data?.artifacts]);
  const binHint = workerBinForArtifact(suggested);

  return { data, isLoading, error, suggested, binHint };
}

export type WorkerDownloadPanelProps = {
  downloads: WorkerDownloadsResponse | undefined;
  isLoading: boolean;
  suggested: WorkerDownloadArtifact | null;
};

export function WorkerDownloadPanel({ downloads, isLoading: downloadsLoading, suggested }: WorkerDownloadPanelProps) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
        <span>Download hive-worker</span>
        {downloads?.tag ? (
          <span className="text-xs font-normal text-muted-foreground">({downloads.tag})</span>
        ) : null}
      </div>
      {downloadsLoading ? (
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading release links…
        </p>
      ) : downloads?.error && (!downloads.artifacts || downloads.artifacts.length === 0) ? (
        <p className="text-xs text-destructive">
          {downloads.error}
          {downloads.releasesPageUrl ? (
            <>
              {" "}
              <a
                href={downloads.releasesPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 text-foreground"
              >
                Open releases page
              </a>
            </>
          ) : null}
        </p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {(downloads?.artifacts ?? []).map((a) => {
            const isPick = suggested?.filename === a.filename;
            return (
              <li key={a.filename} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "font-medium underline underline-offset-2 break-all",
                    isPick ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {a.label}
                </a>
                {isPick ? (
                  <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    suggested
                  </span>
                ) : null}
                {a.sha256 ? (
                  <span className="text-[10px] font-mono text-muted-foreground break-all">
                    sha256 {a.sha256.slice(0, 16)}…
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {downloads?.sha256sumsUrl ? (
        <p className="text-xs text-muted-foreground">
          Verify:{" "}
          <a
            href={downloads.sha256sumsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 text-foreground"
          >
            SHA256SUMS
          </a>
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground leading-snug">
        Extract the archive and run from the directory that contains <code className="font-mono">hive-worker</code>
        {suggested?.platform === "windows" ? (
          <>
            {" "}
            or <code className="font-mono">hive-worker.exe</code>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}
