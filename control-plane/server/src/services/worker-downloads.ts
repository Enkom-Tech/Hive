/**
 * Worker binary download metadata for onboarding UI.
 * Resolution: manifest URL (no GitHub) else GitHub release assets, optional mirror base URL rewrite.
 */

import type { Config } from "../config.js";
import { APP_VERSION } from "@hive/shared/version";

const DEFAULT_RELEASES_REPO = "Enkom-Tech/Hive";
const FETCH_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 512 * 1024;
const SUMS_MAX_BYTES = 256 * 1024;

const VALID_ARTIFACT_FILENAME =
  /^hive-worker_(v\d+\.\d+\.\d+)_(linux|darwin)_(amd64|arm64)\.tar\.gz$|^hive-worker_(v\d+\.\d+\.\d+)_windows_amd64\.zip$/;

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
  /** True when `HIVE_WORKER_DELIVERY_BUS_URL` is set (cross-replica worker WebSocket delivery). */
  workerDeliveryBusConfigured?: boolean;
};

type ManifestArtifact = {
  filename: string;
  url?: string;
  sha256?: string;
  platform?: string;
  arch?: string;
};

type ManifestJson = {
  schemaVersion?: number;
  tag?: string;
  sha256sumsUrl?: string;
  artifacts?: ManifestArtifact[];
};

type RuntimeCfg = {
  manifestUrl: string | undefined;
  releasesRepo: string;
  releaseTag: string;
  artifactBaseUrl: string | undefined;
  githubToken: string | undefined;
  workerDeliveryBusConfigured: boolean;
};

let runtime: RuntimeCfg | null = null;

function normalizeTag(raw: string): string {
  const t = raw.trim();
  if (!t) return `v${APP_VERSION}`;
  return t.startsWith("v") ? t : `v${t}`;
}

export function setWorkerDownloadsConfig(config: Config): void {
  const repo = (config.workerReleasesRepo || config.releasesRepo || DEFAULT_RELEASES_REPO).trim();
  runtime = {
    manifestUrl: config.workerManifestUrl?.trim() || undefined,
    releasesRepo: repo,
    releaseTag: normalizeTag(config.workerReleaseTag?.trim() || APP_VERSION),
    artifactBaseUrl: config.workerArtifactBaseUrl?.trim().replace(/\/+$/, "") || undefined,
    githubToken: config.githubToken?.trim() || undefined,
    workerDeliveryBusConfigured: Boolean(config.workerDeliveryBusUrl?.trim()),
  };
}

export function clearWorkerDownloadsConfig(): void {
  runtime = null;
}

function parseFilenameMeta(filename: string): { platform: string; arch: string; label: string } | null {
  const m = filename.match(
    /^hive-worker_(v\d+\.\d+\.\d+)_(linux|darwin)_(amd64|arm64)\.tar\.gz$/,
  );
  if (m) {
    const platform = m[2];
    const arch = m[3];
    return {
      platform,
      arch,
      label: `${platform === "darwin" ? "macOS" : "Linux"} (${arch})`,
    };
  }
  const w = filename.match(/^hive-worker_(v\d+\.\d+\.\d+)_windows_amd64\.zip$/);
  if (w) {
    return { platform: "windows", arch: "amd64", label: "Windows (amd64)" };
  }
  return null;
}

function parseSha256sums(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([a-f0-9]{64})\s+[*]?\s*(.+)$/i);
    if (!m) continue;
    map.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return map;
}

async function fetchWithTimeout(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const len = res.headers.get("content-length");
  if (len && Number(len) > maxBytes) {
    throw new Error("response too large");
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error("response too large");
  }
  return new TextDecoder("utf-8").decode(buf);
}

function validateManifest(raw: ManifestJson): { tag: string; artifacts: ManifestArtifact[]; sha256sumsUrl?: string } {
  if (raw.schemaVersion !== 1) {
    throw new Error("invalid manifest: schemaVersion must be 1");
  }
  const tag = typeof raw.tag === "string" ? raw.tag.trim() : "";
  if (!tag) {
    throw new Error("invalid manifest: missing tag");
  }
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  if (artifacts.length === 0) {
    throw new Error("invalid manifest: empty artifacts");
  }
  const seen = new Set<string>();
  for (const a of artifacts) {
    const fn = typeof a.filename === "string" ? a.filename.trim() : "";
    const url = typeof a.url === "string" ? a.url.trim() : "";
    if (!fn || !VALID_ARTIFACT_FILENAME.test(fn)) {
      throw new Error(`invalid manifest: bad filename ${fn}`);
    }
    if (!url) {
      throw new Error(`invalid manifest: missing url for ${fn}`);
    }
    if (seen.has(fn)) {
      throw new Error(`invalid manifest: duplicate filename ${fn}`);
    }
    seen.add(fn);
  }
  const sha256sumsUrl =
    typeof raw.sha256sumsUrl === "string" && raw.sha256sumsUrl.trim() ? raw.sha256sumsUrl.trim() : undefined;
  return { tag, artifacts, sha256sumsUrl };
}

function manifestArtifactsToResponse(
  tag: string,
  artifacts: ManifestArtifact[],
  sha256sumsUrl: string | undefined,
): WorkerDownloadsResponse {
  const out: WorkerDownloadArtifact[] = [];
  for (const a of artifacts) {
    const meta = parseFilenameMeta(a.filename);
    if (!meta) continue;
    const platform = typeof a.platform === "string" && a.platform ? a.platform : meta.platform;
    const arch = typeof a.arch === "string" && a.arch ? a.arch : meta.arch;
    out.push({
      filename: a.filename,
      url: a.url!,
      label: meta.label,
      platform,
      arch,
      ...(typeof a.sha256 === "string" && a.sha256 ? { sha256: a.sha256 } : {}),
    });
  }
  return { tag, source: "manifest", artifacts: out, ...(sha256sumsUrl ? { sha256sumsUrl } : {}) };
}

async function enrichSha256(
  res: WorkerDownloadsResponse,
): Promise<WorkerDownloadsResponse> {
  if (!res.sha256sumsUrl) {
    return res;
  }
  try {
    const r = await fetchWithTimeout(res.sha256sumsUrl);
    if (!r.ok) return res;
    const text = await readBodyLimited(r, SUMS_MAX_BYTES);
    const map = parseSha256sums(text);
    const artifacts = res.artifacts.map((a) => ({
      ...a,
      ...(a.sha256 ? {} : map.has(a.filename) ? { sha256: map.get(a.filename) } : {}),
    }));
    return { ...res, artifacts };
  } catch {
    return res;
  }
}

async function resolveFromManifest(manifestUrl: string): Promise<WorkerDownloadsResponse> {
  const res = await fetchWithTimeout(manifestUrl, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return {
      tag: "",
      source: "manifest",
      artifacts: [],
      error: `manifest HTTP ${res.status}`,
    };
  }
  const text = await readBodyLimited(res, MANIFEST_MAX_BYTES);
  let parsed: ManifestJson;
  try {
    parsed = JSON.parse(text) as ManifestJson;
  } catch {
    return { tag: "", source: "manifest", artifacts: [], error: "invalid manifest JSON" };
  }
  try {
    const v = validateManifest(parsed);
    const base = manifestArtifactsToResponse(v.tag, v.artifacts, v.sha256sumsUrl);
    return enrichSha256(base);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { tag: "", source: "manifest", artifacts: [], error: msg };
  }
}

function releasesPageUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases`;
}

async function resolveFromGithub(cfg: RuntimeCfg): Promise<WorkerDownloadsResponse> {
  const [owner, repo] = cfg.releasesRepo.split("/").map((s) => s.trim());
  if (!owner || !repo) {
    return {
      tag: cfg.releaseTag,
      source: "github",
      artifacts: [],
      releasesPageUrl: releasesPageUrl("Enkom-Tech", "Hive"),
      error: "invalid HIVE_WORKER_RELEASES_REPO",
    };
  }
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(cfg.releaseTag)}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (cfg.githubToken) {
    headers.Authorization = `Bearer ${cfg.githubToken}`;
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(apiUrl, { headers });
  } catch {
    return {
      tag: cfg.releaseTag,
      source: "github",
      artifacts: [],
      releasesPageUrl: releasesPageUrl(owner, repo),
      error: "GitHub request failed",
    };
  }
  if (!res.ok) {
    return {
      tag: cfg.releaseTag,
      source: "github",
      artifacts: [],
      releasesPageUrl: releasesPageUrl(owner, repo),
      error: `GitHub HTTP ${res.status}`,
    };
  }
  const data = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  const tag = typeof data.tag_name === "string" ? data.tag_name : cfg.releaseTag;
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const base = cfg.artifactBaseUrl;

  const artifacts: WorkerDownloadArtifact[] = [];
  for (const asset of assets) {
    const name = asset.name?.trim() ?? "";
    if (!VALID_ARTIFACT_FILENAME.test(name)) continue;
    const meta = parseFilenameMeta(name);
    if (!meta) continue;
    const url = base ? `${base}/${name}` : asset.browser_download_url;
    artifacts.push({
      filename: name,
      url,
      label: meta.label,
      platform: meta.platform,
      arch: meta.arch,
    });
  }

  const sha256sumsName = "SHA256SUMS";
  const ghSums = assets.find((a) => a.name === sha256sumsName);
  const sha256sumsUrl = base
    ? `${base}/${sha256sumsName}`
    : ghSums
      ? ghSums.browser_download_url
      : undefined;

  const payload: WorkerDownloadsResponse = {
    tag,
    source: "github",
    artifacts,
    releasesPageUrl: releasesPageUrl(owner, repo),
    ...(sha256sumsUrl ? { sha256sumsUrl } : {}),
  };
  return enrichSha256(payload);
}

function withDeploymentHints(p: WorkerDownloadsResponse): WorkerDownloadsResponse {
  const cfg = runtime;
  if (!cfg) return p;
  return { ...p, workerDeliveryBusConfigured: cfg.workerDeliveryBusConfigured };
}

export async function getWorkerDownloads(): Promise<WorkerDownloadsResponse> {
  const cfg = runtime;
  if (!cfg) {
    return {
      tag: `v${APP_VERSION}`,
      source: "github",
      artifacts: [],
      error: "worker downloads not configured",
    };
  }
  if (cfg.manifestUrl) {
    return withDeploymentHints(await resolveFromManifest(cfg.manifestUrl));
  }
  return withDeploymentHints(await resolveFromGithub(cfg));
}
