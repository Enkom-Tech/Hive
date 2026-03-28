import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityPreviewResult,
} from "@hive/shared";

export type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: string[];
};

export type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

export type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
};

export type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};
