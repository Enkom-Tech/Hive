import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents } from "@hive/db";
import { forbidden } from "../../errors.js";
import { issueService } from "../../services/index.js";

export async function requireAgentInCompany(db: Db, agentId: string, companyId: string): Promise<void> {
  const row = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((r) => r[0] ?? null);
  if (!row || row.status === "terminated" || row.status === "pending_approval") {
    throw forbidden("Agent not in company or not allowed");
  }
}

export async function resolveIssueParam(
  issuesSvc: ReturnType<typeof issueService>,
  issueIdParam: string,
) {
  let issue = await issuesSvc.getById(issueIdParam);
  if (!issue && /^[A-Z]+-\d+$/i.test(issueIdParam.trim())) {
    issue = await issuesSvc.getByIdentifier(issueIdParam.trim());
  }
  return issue;
}
