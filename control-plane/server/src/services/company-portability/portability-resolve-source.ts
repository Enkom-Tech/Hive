import type { CompanyPortabilityManifest, CompanyPortabilityPreview } from "@hive/shared";
import { portabilityManifestSchema } from "@hive/shared";
import {
  fetchJson,
  fetchText,
  parseGitHubTreeUrl,
  resolveRawGitHubUrl,
} from "./portability-shared.js";
import type { ResolvedSource } from "./portability-types.js";
import { ensureMarkdownPath } from "./portability-validate.js";

export function createResolveSource() {
  return async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return {
        manifest: portabilityManifestSchema.parse(source.manifest),
        files: source.files,
        warnings: [],
      };
    }

    if (source.type === "url") {
      const manifestJson = await fetchJson(source.url);
      const manifest = portabilityManifestSchema.parse(manifestJson);
      const base = new URL(".", source.url);
      const files: Record<string, string> = {};
      const warnings: string[] = [];

      if (manifest.company?.path) {
        const companyPath = ensureMarkdownPath(manifest.company.path);
        files[companyPath] = await fetchText(new URL(companyPath, base).toString());
      }
      for (const agent of manifest.agents) {
        const filePath = ensureMarkdownPath(agent.path);
        files[filePath] = await fetchText(new URL(filePath, base).toString());
      }

      return { manifest, files, warnings };
    }

    const parsed = parseGitHubTreeUrl(source.url);
    let ref = parsed.ref;
    const manifestRelativePath = [parsed.basePath, "hive.manifest.json"].filter(Boolean).join("/");
    let manifest: CompanyPortabilityManifest | null = null;
    const warnings: string[] = [];
    try {
      manifest = portabilityManifestSchema.parse(
        await fetchJson(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, manifestRelativePath)),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        manifest = portabilityManifestSchema.parse(
          await fetchJson(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, manifestRelativePath)),
        );
      } else {
        throw err;
      }
    }

    const files: Record<string, string> = {};
    if (manifest.company?.path) {
      files[manifest.company.path] = await fetchText(
        resolveRawGitHubUrl(
          parsed.owner,
          parsed.repo,
          ref,
          [parsed.basePath, manifest.company.path].filter(Boolean).join("/"),
        ),
      );
    }
    for (const agent of manifest.agents) {
      files[agent.path] = await fetchText(
        resolveRawGitHubUrl(
          parsed.owner,
          parsed.repo,
          ref,
          [parsed.basePath, agent.path].filter(Boolean).join("/"),
        ),
      );
    }
    return { manifest, files, warnings };
  };
}

export type ResolveSourceFn = ReturnType<typeof createResolveSource>;
