/**
 * Release check: fetches latest GitHub release, caches with TTL, returns current vs latest for update banner.
 * Config: setReleaseCheckConfig() at server startup (releasesRepo, updateCheckDisabled).
 */

const DEFAULT_REPO = "Enkom-Tech/Hive";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

export type ReleaseCheckResult = {
  currentVersion: string;
  latestVersion?: string;
  releasesUrl?: string;
};

let cache: { latestVersion: string; releasesUrl: string; expiresAt: number } | null = null;
let releaseCheckConfig: { releasesRepo: string; updateCheckDisabled: boolean } | null = null;

/** Set from server config. Call once at server startup. */
export function setReleaseCheckConfig(cfg: {
  releasesRepo: string | undefined;
  updateCheckDisabled: boolean;
}): void {
  releaseCheckConfig = {
    releasesRepo: cfg.releasesRepo?.trim() || DEFAULT_REPO,
    updateCheckDisabled: cfg.updateCheckDisabled,
  };
}

/** Clear in-memory cache (for tests). */
export function clearReleaseCheckCache(): void {
  cache = null;
}

function parseStableVersion(tag: string): string {
  const v = tag.replace(/^v/i, "").trim();
  const dash = v.indexOf("-");
  return dash >= 0 ? v.slice(0, dash) : v;
}

function semverGt(a: string, b: string): boolean {
  const parts = (s: string) => s.split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

function getRepo(): string {
  return releaseCheckConfig?.releasesRepo ?? DEFAULT_REPO;
}

export async function getReleaseCheck(currentVersion: string): Promise<ReleaseCheckResult> {
  const result: ReleaseCheckResult = { currentVersion };
  if (releaseCheckConfig?.updateCheckDisabled) {
    return result;
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    if (semverGt(cache.latestVersion, currentVersion)) {
      result.latestVersion = cache.latestVersion;
      result.releasesUrl = cache.releasesUrl;
    }
    return result;
  }

  const repo = getRepo();
  const [owner, repoName] = repo.split("/");
  const releasesUrl = `https://github.com/${owner}/${repoName}/releases`;
  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/releases/latest`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return result;
    }

    const data = (await res.json()) as { tag_name?: string };
    const tag = data?.tag_name;
    if (!tag || typeof tag !== "string") {
      return result;
    }

    const latestVersion = parseStableVersion(tag);
    if (!/^\d+\.\d+\.\d+$/.test(latestVersion)) {
      return result;
    }

    cache = {
      latestVersion,
      releasesUrl,
      expiresAt: now + CACHE_TTL_MS,
    };

    if (semverGt(latestVersion, currentVersion)) {
      result.latestVersion = latestVersion;
      result.releasesUrl = releasesUrl;
    }
  } catch {
    // Timeout or network error: return only currentVersion
  }

  return result;
}
