/**
 * Links to source files in the public Hive repo (for operators without a local checkout).
 * Keep paths relative to repository root; must match Enkom-Tech/Hive layout.
 */
const GITHUB_BLOB_MAIN = "https://github.com/Enkom-Tech/Hive/blob/main";

export function workerGithubBlob(repoRelativePath: string): string {
  const p = repoRelativePath.replace(/^\/+/, "");
  return `${GITHUB_BLOB_MAIN}/${p}`;
}
