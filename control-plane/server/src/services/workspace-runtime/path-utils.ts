import path from "node:path";
import { resolveHomeAwarePath } from "../../home-paths.js";

export function sanitizeBranchName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._/-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-/.]+|[-/.]+$/g, "")
      .slice(0, 120) || "hive-work"
  );
}

export function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

export function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

/** Throws if candidatePath is not under rootPath (prevents path traversal). */
export function ensurePathUnderRoot(candidatePath: string, rootPath: string, label: string): void {
  const rootResolved = path.resolve(rootPath);
  const rootWithSep = rootResolved + path.sep;
  const candidateResolved = path.resolve(candidatePath);
  if (candidateResolved !== rootResolved && !candidateResolved.startsWith(rootWithSep)) {
    throw new Error(`${label} resolves outside repository root (${candidatePath})`);
  }
}
