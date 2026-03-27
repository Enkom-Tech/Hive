import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { issues } from "@hive/db";
import { teardownIssueExecutionWorkspaceOnVcsMerge } from "./workspace-runtime.js";

export function verifyGithubWebhookSignature(
  rawBody: Buffer,
  secret: string,
  sigHeader: string | undefined,
): boolean {
  const s = secret.trim();
  if (!s || !sigHeader?.startsWith("sha256=")) return false;
  const expectedHex = createHmac("sha256", s).update(rawBody).digest("hex");
  const gotHex = sigHeader.slice(7).trim();
  if (!/^[0-9a-f]+$/i.test(expectedHex) || expectedHex.length !== gotHex.length) return false;
  try {
    const a = Buffer.from(expectedHex, "hex");
    const b = Buffer.from(gotHex, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function processGithubPullRequestMerge(
  db: Db,
  companyId: string,
  payload: unknown,
  opts: { allowedRepos?: string[] },
): Promise<{ processedIssues: number }> {
  const o = payload as Record<string, unknown>;
  if (o.action !== "closed") return { processedIssues: 0 };
  const pr = o.pull_request as Record<string, unknown> | undefined;
  if (!pr || pr.merged !== true) return { processedIssues: 0 };
  const head = pr.head as Record<string, unknown> | undefined;
  const ref = typeof head?.ref === "string" ? head.ref.trim() : "";
  if (!ref) return { processedIssues: 0 };

  const repo = o.repository as Record<string, unknown> | undefined;
  const fullName = typeof repo?.full_name === "string" ? repo.full_name.trim() : "";
  if (opts.allowedRepos && opts.allowedRepos.length > 0) {
    if (!fullName || !opts.allowedRepos.includes(fullName)) {
      return { processedIssues: 0 };
    }
  }

  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.executionWorkspaceBranch, ref)));

  let processedIssues = 0;
  for (const r of rows) {
    await teardownIssueExecutionWorkspaceOnVcsMerge(db, r.id, ref);
    processedIssues += 1;
  }
  return { processedIssues };
}
