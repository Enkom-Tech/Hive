export type ReleaseCheckResponse = {
  currentVersion: string;
  latestVersion?: string;
  releasesUrl?: string;
};

export const releasesApi = {
  check: async (): Promise<ReleaseCheckResponse> => {
    const res = await fetch("/api/releases/check", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to check releases (${res.status})`);
    }
    return res.json();
  },
};
