import type { CompanyPortabilityExport, CompanyPortabilityExportResult, CompanyPortabilityManifest } from "@hive/shared";
import { notFound } from "../../errors.js";
import { agentService } from "../agents.js";
import { companyService } from "../companies.js";
import {
  ADAPTER_DEFAULT_RULES_BY_TYPE,
  buildMarkdown,
  dedupeRequiredSecrets,
  normalizeInclude,
  normalizePortableConfig,
  pruneDefaultLikeValue,
  readAgentInstructions,
  renderCompanyAgentsSection,
  RUNTIME_DEFAULT_RULES,
  toSafeSlug,
  uniqueSlug,
} from "./portability-shared.js";

export function createPortabilityExport(deps: {
  companies: ReturnType<typeof companyService>;
  agents: ReturnType<typeof agentService>;
}) {
  const { companies, agents } = deps;

  return async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude(input.include);
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, string> = {};
    const warnings: string[] = [];
    const requiredSecrets: CompanyPortabilityManifest["requiredSecrets"] = [];
    const generatedAt = new Date().toISOString();

    const manifest: CompanyPortabilityManifest = {
      schemaVersion: 1,
      generatedAt,
      source: {
        companyId: company.id,
        companyName: company.name,
      },
      includes: include,
      company: null,
      agents: [],
      requiredSecrets: [],
    };

    const allAgentRows = include.agents ? await agents.list(companyId, { includeTerminated: true }) : [];
    const agentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    if (include.agents) {
      const skipped = allAgentRows.length - agentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    if (include.company) {
      const companyPath = "COMPANY.md";
      const companyAgentSummaries = agentRows.map((agent) => ({
        slug: idToSlug.get(agent.id) ?? "agent",
        name: agent.name,
      }));
      files[companyPath] = buildMarkdown(
        {
          kind: "company",
          name: company.name,
          description: company.description ?? null,
          productionPolicies: company.productionPolicies ?? null,
          brandColor: company.brandColor ?? null,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents,
        },
        renderCompanyAgentsSection(companyAgentSummaries),
      );
      manifest.company = {
        path: companyPath,
        name: company.name,
        description: company.description ?? null,
        productionPolicies: company.productionPolicies ?? null,
        brandColor: company.brandColor ?? null,
        requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents,
      };
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const instructions = await readAgentInstructions(agent);
        if (instructions.warning) warnings.push(instructions.warning);
        const agentPath = `agents/${slug}/AGENTS.md`;

        const secretStart = requiredSecrets.length;
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.adapterConfig, slug, requiredSecrets),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig, slug, requiredSecrets),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, {
          dropFalseBooleans: true,
        }) as Record<string, unknown>;
        const agentRequiredSecrets = dedupeRequiredSecrets(
          requiredSecrets.slice(secretStart).filter((requirement) => requirement.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;

        files[agentPath] = buildMarkdown(
          {
            name: agent.name,
            slug,
            role: agent.role,
            adapterType: agent.adapterType,
            kind: "agent",
            icon: agent.icon ?? null,
            capabilities: agent.capabilities ?? null,
            reportsTo: reportsToSlug,
            runtimeConfig: portableRuntimeConfig,
            permissions: portablePermissions,
            adapterConfig: portableAdapterConfig,
            requiredSecrets: agentRequiredSecrets,
          },
          instructions.body,
        );

        manifest.agents.push({
          slug,
          name: agent.name,
          path: agentPath,
          role: agent.role,
          title: agent.title ?? null,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          reportsToSlug,
          adapterType: agent.adapterType,
          adapterConfig: portableAdapterConfig,
          runtimeConfig: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        });
      }
    }

    manifest.requiredSecrets = dedupeRequiredSecrets(requiredSecrets);
    return {
      manifest,
      files,
      warnings,
    };
  };
}
