import fs from "node:fs/promises";

export type WorkerProvisionManifest = {
  version: string;
  adapters: Record<string, { url: string; sha256?: string }>;
  /** Debian package names for optional worker-side hooks (HIVE_PROVISION_MANIFEST_HOOKS=1). */
  aptPackages?: string[];
  /** npm install -g specs (no shell metacharacters). */
  npmGlobal?: string[];
  /** docker pull references. */
  dockerImages?: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const debNameRe = /^[a-z0-9][a-z0-9+.-]*$/;
const npmGlobalRe = /^[a-zA-Z0-9@^~./_-]+$/;
const dockerRefRe = /^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*$/;

function parseOptionalStringArray(
  raw: unknown,
  field: string,
  validate: (s: string) => boolean,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`provision manifest ${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`provision manifest ${field} entries must be non-empty strings`);
    }
    const s = item.trim();
    if (!validate(s)) {
      throw new Error(`provision manifest ${field} has invalid entry ${JSON.stringify(s)}`);
    }
    out.push(s);
  }
  return out.length ? out : undefined;
}

export function parseWorkerProvisionManifest(raw: string): WorkerProvisionManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("provision manifest must be a JSON object");
  }
  const version = typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "v1";
  const adaptersRaw = parsed.adapters;
  if (!isRecord(adaptersRaw)) {
    throw new Error("provision manifest must include an adapters object");
  }

  const adapters: Record<string, { url: string; sha256?: string }> = {};
  for (const [key, value] of Object.entries(adaptersRaw)) {
    if (!isRecord(value) || typeof value.url !== "string" || value.url.trim() === "") {
      throw new Error(`manifest.adapters.${key} must contain a non-empty url`);
    }
    const url = value.url.trim();
    if (!url.toLowerCase().startsWith("https://")) {
      throw new Error(`manifest.adapters.${key}.url must use https`);
    }
    const sha256 =
      typeof value.sha256 === "string" && value.sha256.trim().length > 0 ? value.sha256.trim() : undefined;
    adapters[key] = { url, sha256 };
  }

  const aptPackages = parseOptionalStringArray(parsed.aptPackages, "aptPackages", (s) => debNameRe.test(s));
  const npmGlobal = parseOptionalStringArray(parsed.npmGlobal, "npmGlobal", (s) => npmGlobalRe.test(s) && !s.includes(".."));
  const dockerImages = parseOptionalStringArray(
    parsed.dockerImages,
    "dockerImages",
    (s) => dockerRefRe.test(s) && !s.includes(".."),
  );

  return { version, adapters, aptPackages, npmGlobal, dockerImages };
}

export async function loadWorkerProvisionManifest(opts: {
  inlineJson?: string;
  filePath?: string;
}): Promise<WorkerProvisionManifest | null> {
  if (opts.inlineJson && opts.inlineJson.trim()) {
    return parseWorkerProvisionManifest(opts.inlineJson.trim());
  }
  if (opts.filePath && opts.filePath.trim()) {
    const fileContent = await fs.readFile(opts.filePath.trim(), "utf8");
    return parseWorkerProvisionManifest(fileContent);
  }
  return null;
}

/** Company JSON overrides instance-global server manifest when present and non-empty. */
export async function resolveEffectiveWorkerRuntimeManifest(opts: {
  companyManifestJson: string | null | undefined;
  globalInlineJson?: string;
  globalFilePath?: string;
}): Promise<WorkerProvisionManifest | null> {
  if (opts.companyManifestJson && opts.companyManifestJson.trim()) {
    return parseWorkerProvisionManifest(opts.companyManifestJson.trim());
  }
  return loadWorkerProvisionManifest({
    inlineJson: opts.globalInlineJson,
    filePath: opts.globalFilePath,
  });
}
