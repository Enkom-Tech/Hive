import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompanyPortabilityInclude, CompanyPortabilityManifest } from "@hive/shared";
import { normalizeAgentUrlKey } from "@hive/shared";
import { unprocessable } from "../../errors.js";
import type { AgentLike, MarkdownDoc } from "./portability-types.js";

export const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
};

export const DEFAULT_COLLISION_STRATEGY = "rename" as const;

export const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

export const RUNTIME_DEFAULT_RULES: Array<{ path: string[]; value: unknown }> = [
  { path: ["heartbeat", "cooldownSec"], value: 10 },
  { path: ["heartbeat", "intervalSec"], value: 3600 },
  { path: ["heartbeat", "wakeOnOnDemand"], value: true },
  { path: ["heartbeat", "wakeOnAssignment"], value: true },
  { path: ["heartbeat", "wakeOnAutomation"], value: true },
  { path: ["heartbeat", "wakeOnDemand"], value: true },
  { path: ["heartbeat", "maxConcurrentRuns"], value: 3 },
];

export const ADAPTER_DEFAULT_RULES_BY_TYPE: Record<string, Array<{ path: string[]; value: unknown }>> = {
  managed_worker: [
    { path: ["timeoutSec"], value: 120 },
    { path: ["graceSec"], value: 15 },
  ],
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toSafeSlug(input: string, fallback: string) {
  return normalizeAgentUrlKey(input) ?? fallback;
}

export function uniqueSlug(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

export function uniqueNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeAgentUrlKey(baseName) ?? "agent";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeAgentUrlKey(candidateName) ?? `agent-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

export function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
  };
}

export function normalizePortableEnv(
  agentSlug: string,
  envValue: unknown,
  requiredSecrets: CompanyPortabilityManifest["requiredSecrets"],
) {
  if (typeof envValue !== "object" || envValue === null || Array.isArray(envValue)) return {};
  const env = envValue as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, binding] of Object.entries(env)) {
    if (SENSITIVE_ENV_KEY_RE.test(key)) {
      requiredSecrets.push({
        key,
        description: `Set ${key} for agent ${agentSlug}`,
        agentSlug,
        providerHint: null,
      });
      continue;
    }
    next[key] = binding;
  }
  return next;
}

export function normalizePortableConfig(
  value: unknown,
  agentSlug: string,
  requiredSecrets: CompanyPortabilityManifest["requiredSecrets"],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (key === "cwd" || key === "instructionsFilePath") continue;
    if (key === "env") {
      next[key] = normalizePortableEnv(agentSlug, entry, requiredSecrets);
      continue;
    }
    next[key] = entry;
  }

  return next;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPathDefault(pathSegments: string[], value: unknown, rules: Array<{ path: string[]; value: unknown }>) {
  return rules.some((rule) => jsonEqual(rule.path, pathSegments) && jsonEqual(rule.value, value));
}

export function pruneDefaultLikeValue(
  value: unknown,
  opts: {
    dropFalseBooleans: boolean;
    path?: string[];
    defaultRules?: Array<{ path: string[]; value: unknown }>;
  },
): unknown {
  const pathSegments = opts.path ?? [];
  if (opts.defaultRules && isPathDefault(pathSegments, value, opts.defaultRules)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pruneDefaultLikeValue(entry, { ...opts, path: pathSegments }));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = pruneDefaultLikeValue(entry, {
        ...opts,
        path: [...pathSegments, key],
      });
      if (next === undefined) continue;
      out[key] = next;
    }
    return out;
  }
  if (value === undefined) return undefined;
  if (opts.dropFalseBooleans && value === false) return undefined;
  return value;
}

function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        (Array.isArray(entry) && entry.length === 0) ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        (Array.isArray(entry) && entry.length === 0) ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${renderYamlScalar(value)}`];
}

function renderFrontmatter(frontmatter: Record<string, unknown>) {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    const scalar =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      (Array.isArray(value) && value.length === 0) ||
      isEmptyObject(value);
    if (scalar) {
      lines.push(`${key}: ${renderYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(...renderYamlBlock(value, 1));
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

export function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const cleanBody = body.replace(/\r\n/g, "\n").trim();
  if (!cleanBody) {
    return `${renderFrontmatter(frontmatter)}\n`;
  }
  return `${renderFrontmatter(frontmatter)}\n${cleanBody}\n`;
}

export function renderCompanyAgentsSection(agentSummaries: Array<{ slug: string; name: string }>) {
  const lines = ["# Agents", ""];
  if (agentSummaries.length === 0) {
    lines.push("- _none_");
    return lines.join("\n");
  }
  for (const agent of agentSummaries) {
    lines.push(`- ${agent.slug} - ${agent.name}`);
  }
  return lines.join("\n");
}

export function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterRaw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (!key) continue;
    if (rawValue === "null") {
      frontmatter[key] = null;
      continue;
    }
    if (rawValue === "true" || rawValue === "false") {
      frontmatter[key] = rawValue === "true";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      frontmatter[key] = Number(rawValue);
      continue;
    }
    try {
      frontmatter[key] = JSON.parse(rawValue);
      continue;
    } catch {
      frontmatter[key] = rawValue;
    }
  }
  return { frontmatter, body };
}

export async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

export async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export function dedupeRequiredSecrets(values: CompanyPortabilityManifest["requiredSecrets"]) {
  const seen = new Set<string>();
  const out: CompanyPortabilityManifest["requiredSecrets"] = [];
  for (const value of values) {
    const key = `${value.agentSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function parseGitHubTreeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  let ref = "main";
  let basePath = "";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  }
  return { owner, repo, ref, basePath };
}

export function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  const normalizedFilePath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${normalizedFilePath}`;
}

export async function readAgentInstructions(agent: AgentLike): Promise<{ body: string; warning: string | null }> {
  const config = agent.adapterConfig as Record<string, unknown>;
  const instructionsFilePath = asString(config.instructionsFilePath);
  if (instructionsFilePath) {
    const workspaceCwd = asString(
      process.env.HIVE_WORKSPACE_CWD ?? process.env.HIVE_WORKSPACE_CWD,
    );
    const candidates = new Set<string>();
    if (path.isAbsolute(instructionsFilePath)) {
      candidates.add(instructionsFilePath);
    } else {
      if (workspaceCwd) candidates.add(path.resolve(workspaceCwd, instructionsFilePath));
      candidates.add(path.resolve(process.cwd(), instructionsFilePath));
    }

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const body = await Promise.race([
          fs.readFile(candidate, "utf8"),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("timed out reading instructions file")), 1500);
          }),
        ]);
        return { body, warning: null };
      } catch {
        // try next candidate
      }
    }
  }
  const promptTemplate = asString(config.promptTemplate);
  if (promptTemplate) {
    const warning = instructionsFilePath
      ? `Agent ${agent.name} instructionsFilePath was not readable; fell back to promptTemplate.`
      : null;
    return {
      body: promptTemplate,
      warning,
    };
  }
  return {
    body: "_No AGENTS instructions were resolved from current agent config._",
    warning: `Agent ${agent.name} has no resolvable instructionsFilePath/promptTemplate; exported placeholder AGENTS.md.`,
  };
}
