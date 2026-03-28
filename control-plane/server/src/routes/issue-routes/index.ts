import { Router } from "express";
import type { Db } from "@hive/db";
import type { StorageService } from "../../storage/types.js";
import { createIssueRoutesContext } from "./context.js";
import { registerIssueRouteParams } from "./issue-route-params.js";
import { registerIssueCrudRoutes } from "./issue-crud-routes.js";
import { registerIssueLabelsRoutes } from "./issue-labels-routes.js";
import { registerIssueApprovalsRoutes } from "./issue-approvals-routes.js";
import { registerIssueCheckoutRoutes } from "./issue-checkout-routes.js";
import { registerIssueCommentsRoutes } from "./issue-comments-routes.js";
import { registerIssueAttachmentsRoutes } from "./issue-attachments-routes.js";

export function issueRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const ctx = createIssueRoutesContext(db, storage);

  registerIssueRouteParams(router, ctx);
  registerIssueCrudRoutes(router, ctx);
  registerIssueLabelsRoutes(router, ctx);
  registerIssueApprovalsRoutes(router, ctx);
  registerIssueCheckoutRoutes(router, ctx);
  registerIssueCommentsRoutes(router, ctx);
  registerIssueAttachmentsRoutes(router, ctx);

  return router;
}
