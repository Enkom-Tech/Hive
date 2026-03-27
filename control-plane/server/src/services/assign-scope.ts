import { eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents } from "@hive/db";

/**
 * Pure subtree walk for `tasks:assign_scope` (used by tests and {@link isAssigneeAllowedByAgentScope}).
 * Assignee must be `rootAgentId` or an agent whose `reports_to` chain reaches `rootAgentId`.
 */
export function assigneeAllowedByScopeParentMap(
  assigneeAgentId: string,
  rootAgentId: string,
  excludeAgentIds: string[],
  parentById: Map<string, string | null>,
): boolean {
  if (excludeAgentIds.includes(assigneeAgentId)) return false;

  let cur: string | null = assigneeAgentId;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    if (cur === rootAgentId) return true;
    cur = parentById.get(cur) ?? null;
  }
  return false;
}

/**
 * JSON scope on `tasks:assign_scope` grants.
 * Assignee must be `rootAgentId` or an agent whose `reports_to` chain reaches `rootAgentId`.
 */
export async function isAssigneeAllowedByAgentScope(
  db: Db,
  companyId: string,
  assigneeAgentId: string,
  scope: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  if (!scope || typeof scope !== "object") return false;
  const rootRaw = scope.rootAgentId;
  if (typeof rootRaw !== "string" || rootRaw.length === 0) return false;
  const excludeRaw = scope.excludeAgentIds;
  const exclude = Array.isArray(excludeRaw)
    ? excludeRaw.filter((x): x is string => typeof x === "string")
    : [];

  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const parentById = new Map(rows.map((r) => [r.id, r.reportsTo as string | null]));

  return assigneeAllowedByScopeParentMap(assigneeAgentId, rootRaw, exclude, parentById);
}
