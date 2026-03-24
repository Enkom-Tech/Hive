import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { companies, departments, projects } from "@hive/db";
import { readNonEmptyString } from "./heartbeat/types.js";

/**
 * Builds additive production-agent context: company, then department, then project.
 * Intended for execution prompts — not executive mission/goals.
 */
export async function formatProductionPoliciesForRun(
  db: Db,
  companyId: string,
  projectId: string | null | undefined,
  departmentId: string | null | undefined,
): Promise<string | null> {
  const companyRow = await db
    .select({ productionPolicies: companies.productionPolicies })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]);
  const companyText = readNonEmptyString(companyRow?.productionPolicies ?? null);

  let deptText: string | null = null;
  if (departmentId) {
    const d = await db
      .select({ productionPolicies: departments.productionPolicies })
      .from(departments)
      .where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)))
      .then((rows) => rows[0]);
    deptText = readNonEmptyString(d?.productionPolicies ?? null);
  }

  let projText: string | null = null;
  if (projectId) {
    const p = await db
      .select({ productionPolicies: projects.productionPolicies })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0]);
    projText = readNonEmptyString(p?.productionPolicies ?? null);
  }

  const parts: string[] = [];
  if (companyText) parts.push(`## Company production policies\n\n${companyText.trim()}`);
  if (deptText) parts.push(`## Department production policies\n\n${deptText.trim()}`);
  if (projText) parts.push(`## Project production policies\n\n${projText.trim()}`);
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
