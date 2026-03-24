/**
 * Shared attachment content-type configuration.
 *
 * By default only image types are allowed.  Set the
 * `HIVE_ALLOWED_ATTACHMENT_TYPES` environment variable to a
 * comma-separated list of MIME types or wildcard patterns to expand the
 * allowed set.
 *
 * Examples:
 *   HIVE_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf
 *   HIVE_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf,text/*
 *
 * Supported pattern syntax:
 *   - Exact types:   "application/pdf"
 *   - Wildcards:     "image/*"  or  "application/vnd.openxmlformats-officedocument.*"
 */

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
];

/**
 * Parse a comma-separated list of MIME type patterns into a normalised array.
 * Returns the default image-only list when the input is empty or undefined.
 */
export function parseAllowedTypes(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_TYPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_TYPES];
}

/**
 * Check whether `contentType` matches any entry in `allowedPatterns`.
 *
 * Supports exact matches ("application/pdf") and wildcard / prefix
 * patterns ("image/*", "application/vnd.openxmlformats-officedocument.*").
 */
export function matchesContentType(contentType: string, allowedPatterns: string[]): boolean {
  const ct = contentType.toLowerCase();
  return allowedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      return ct.startsWith(pattern.slice(0, -1));
    }
    return ct === pattern;
  });
}

// ---------- Config set at startup from server config (no process.env) ----------

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

let attachmentConfig: {
  allowedPatterns: string[];
  maxBytes: number;
} | null = null;

/**
 * Set attachment config from server config. Call once at server startup.
 */
export function setAttachmentConfig(cfg: { allowedTypesRaw: string; maxBytes: number }): void {
  attachmentConfig = {
    allowedPatterns: parseAllowedTypes(cfg.allowedTypesRaw || undefined),
    maxBytes: cfg.maxBytes > 0 ? cfg.maxBytes : DEFAULT_MAX_BYTES,
  };
}

function getAttachmentConfig(): { allowedPatterns: string[]; maxBytes: number } {
  if (attachmentConfig) return attachmentConfig;
  return {
    allowedPatterns: [...DEFAULT_ALLOWED_TYPES],
    maxBytes: DEFAULT_MAX_BYTES,
  };
}

/** Convenience wrapper using the configured allowed list. */
export function isAllowedContentType(contentType: string): boolean {
  return matchesContentType(contentType, getAttachmentConfig().allowedPatterns);
}

export function getMaxAttachmentBytes(): number {
  return getAttachmentConfig().maxBytes;
}

/** @deprecated Use getMaxAttachmentBytes() for config-driven value. */
export const MAX_ATTACHMENT_BYTES = DEFAULT_MAX_BYTES;
