import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import type { StorageService } from "../../storage/types.js";
import { createIssueRoutesContext } from "./context.js";
import { registerIssueCrudRoutesF } from "./issue-crud-routes.js";
import { registerIssueLabelsRoutesF } from "./issue-labels-routes.js";
import { registerIssueApprovalsRoutesF } from "./issue-approvals-routes.js";
import { registerIssueCheckoutRoutesF } from "./issue-checkout-routes.js";
import { registerIssueCommentsRoutesF } from "./issue-comments-routes.js";

export async function issuesPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; storage: StorageService },
): Promise<void> {
  const ctx = createIssueRoutesContext(opts.db, opts.storage);
  registerIssueCrudRoutesF(fastify, ctx);
  registerIssueLabelsRoutesF(fastify, ctx);
  registerIssueApprovalsRoutesF(fastify, ctx);
  registerIssueCheckoutRoutesF(fastify, ctx);
  registerIssueCommentsRoutesF(fastify, ctx);
}
