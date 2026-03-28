import type { CompanyPortabilityImport, CompanyPortabilityImportResult } from "@hive/shared";
import { DEFAULT_HIVE_DEPLOYMENT_ID, normalizeAgentUrlKey } from "@hive/shared";
import { notFound, unprocessable } from "../../errors.js";
import { accessService } from "../access.js";
import { agentService } from "../agents.js";
import { companyService } from "../companies.js";
import { asString, parseFrontmatterMarkdown } from "./portability-shared.js";
import type { BuildPreviewFn } from "./portability-preview.js";

export function createPortabilityImport(deps: {
  buildPreview: BuildPreviewFn;
  companies: ReturnType<typeof companyService>;
  agents: ReturnType<typeof agentService>;
  access: ReturnType<typeof accessService>;
}) {
  const { buildPreview, companies, agents, access } = deps;

  return async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
  ): Promise<CompanyPortabilityImportResult> {
    const plan = await buildPreview(input);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      const created = await companies.create({
        deploymentId: DEFAULT_HIVE_DEPLOYMENT_ID,
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        productionPolicies: include.company ? (sourceManifest.company?.productionPolicies ?? null) : null,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
          : true,
      });
      await access.ensureMembership(created.id, "user", actorUserId ?? "board", "admin", "active");
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company) {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          productionPolicies: sourceManifest.company.productionPolicies ?? null,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const markdownRaw = plan.source.files[manifestAgent.path];
        if (!markdownRaw) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported without prompt template.`);
        }
        const markdown = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : { frontmatter: {}, body: "" };
        const adapterConfig = {
          ...manifestAgent.adapterConfig,
          promptTemplate:
            markdown.body ||
            asString((manifestAgent.adapterConfig as Record<string, unknown>).promptTemplate) ||
            "",
        } as Record<string, unknown>;
        delete adapterConfig.instructionsFilePath;
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          adapterType: manifestAgent.adapterType,
          adapterConfig,
          runtimeConfig: manifestAgent.runtimeConfig,
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          const updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing agent ${planAgent.existingAgentId}.`);
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        const created = await agents.create(targetCompany.id, patch);
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, { reportsTo: managerId });
        } catch {
          warnings.push(`Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`);
        }
      }
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      requiredSecrets: sourceManifest.requiredSecrets ?? [],
      warnings,
    };
  };
}
