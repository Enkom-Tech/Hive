export type WorkerDownloadArtifact = {
  label: string;
  platform: string;
  arch: string;
  filename: string;
  url: string;
  sha256?: string;
};

export type WorkerDownloadsResponse = {
  tag: string;
  source: "manifest" | "github";
  artifacts: WorkerDownloadArtifact[];
  sha256sumsUrl?: string;
  releasesPageUrl?: string;
  error?: string;
  /** Present when server exposes deployment hints (cross-replica delivery bus). */
  workerDeliveryBusConfigured?: boolean;
};

export const workerDownloadsApi = {
  get: async (): Promise<WorkerDownloadsResponse> => {
    const res = await fetch("/api/worker-downloads/", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load worker downloads (${res.status})`);
    }
    return res.json();
  },
};
