import { desc, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { issueComments, issues } from "@hive/db";
import { notFound } from "../../errors.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactIssueComment } from "./user-context.js";

export function createIssueCommentOps(db: Db) {
  return {
    listComments: (issueId: string) =>
      db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(desc(issueComments.createdAt))
        .then((comments) => comments.map(redactIssueComment)),

    getComment: (commentId: string) =>
      db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => {
          const comment = rows[0] ?? null;
          return comment ? redactIssueComment(comment) : null;
        }),

    addComment: async (issueId: string, body: string, actor: { agentId?: string; userId?: string }) => {
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const redactedBody = redactCurrentUserText(body);
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning();

      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      return redactIssueComment(comment);
    },
  };
}
