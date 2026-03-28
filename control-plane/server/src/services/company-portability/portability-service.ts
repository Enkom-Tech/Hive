import type { Db } from "@hive/db";
import type { CompanyPortabilityPreview } from "@hive/shared";
import { accessService } from "../access.js";
import { agentService } from "../agents.js";
import { companyService } from "../companies.js";
import { createPortabilityExport } from "./portability-export.js";
import { createPortabilityImport } from "./portability-import.js";
import { createPortabilityPreview } from "./portability-preview.js";
import { createResolveSource } from "./portability-resolve-source.js";

export function companyPortabilityService(db: Db) {
  const companies = companyService(db);
  const agents = agentService(db);
  const access = accessService(db);
  const resolveSource = createResolveSource();
  const buildPreview = createPortabilityPreview({ resolveSource, companies, agents });
  const exportBundle = createPortabilityExport({ companies, agents });
  const importBundle = createPortabilityImport({ buildPreview, companies, agents, access });

  return {
    exportBundle,
    previewImport: async (input: CompanyPortabilityPreview) => (await buildPreview(input)).preview,
    importBundle,
  };
}
