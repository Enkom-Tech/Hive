import type { Db } from "@hive/db";
import { createAssigneeAssertions } from "./assignees.js";
import { createIssueLabelOps } from "./labels-ops.js";
import { createIssueCommentOps } from "./comments-ops.js";
import { createIssueAttachmentOps } from "./attachments-ops.js";
import { createIssueQueryExtras } from "./query-extras.js";
import { createIssueCheckoutOps } from "./checkout-ops.js";
import { createIssueCrudOps } from "./crud-ops.js";

export function issueService(db: Db) {
  const assignees = createAssigneeAssertions(db);
  const labelOps = createIssueLabelOps(db);
  const crud = createIssueCrudOps(db, assignees, labelOps);
  const comments = createIssueCommentOps(db);
  const attachments = createIssueAttachmentOps(db);
  const queryExtras = createIssueQueryExtras(db);
  const checkout = createIssueCheckoutOps(db, assignees);

  return {
    ...crud,
    ...checkout,
    listLabels: labelOps.listLabels,
    getLabelById: labelOps.getLabelById,
    createLabel: labelOps.createLabel,
    deleteLabel: labelOps.deleteLabel,
    ...comments,
    ...attachments,
    ...queryExtras,
  };
}
