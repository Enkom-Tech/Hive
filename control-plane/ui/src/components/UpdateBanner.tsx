import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { releasesApi } from "../api/releases";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const DISMISSED_STORAGE_KEY = "hive.update-banner.dismissedVersion";
const STALE_TIME_MS = 30 * 60 * 1000; // 30 min

function parseParts(s: string): number[] {
  return s.split(".").map((n) => parseInt(n, 10) || 0);
}

function semverGt(a: string, b: string): boolean {
  const pa = parseParts(a);
  const pb = parseParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

function loadDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function UpdateBanner() {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => loadDismissedVersion());

  const { data } = useQuery({
    queryKey: queryKeys.releases.check,
    queryFn: () => releasesApi.check(),
    staleTime: STALE_TIME_MS,
    retry: false,
  });

  const dismiss = useCallback((version: string) => {
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, version);
      setDismissedVersion(version);
    } catch {
      setDismissedVersion(version);
    }
  }, []);

  const effectiveDismissed = dismissedVersion ?? loadDismissedVersion();
  const latest = data?.latestVersion;
  const current = data?.currentVersion ?? "";
  const releasesUrl = data?.releasesUrl;

  const show =
    latest &&
    releasesUrl &&
    semverGt(latest, current) &&
    latest !== effectiveDismissed;

  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-2 px-3 py-2 text-sm",
        "bg-muted text-muted-foreground",
        "border border-border rounded-lg mx-4 md:mx-6 mt-2",
      )}
    >
      <span>
        Update available:{" "}
        <a
          href={releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          v{latest}
        </a>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => dismiss(latest)}
        aria-label="Dismiss update banner"
        title="Dismiss"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
