import type { Router } from "express";
import { checkoutIssueSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { assertCompanyPermission, getActorInfo } from "../authz.js";
import { logActivity } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { shouldWakeAssigneeOnCheckout } from "../issues-checkout-wakeup.js";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueCheckoutRoutes(router: Router, ctx: IssueRoutesContext): void {
  const { db, svc, heartbeat } = ctx;

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyPermission(db, req, issue.companyId, "issues:write");

    const pCheckout = getCurrentPrincipal(req);
    if (pCheckout?.type === "agent" && pCheckout.id !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const checkoutRunId = ctx.requireAgentRunId(req, res);
    if (pCheckout?.type === "agent" && !checkoutRunId) return;
    if (checkoutRunId) {
      const ensuredRun = await heartbeat.ensureExternalRunForCheckout(
        issue.companyId,
        req.body.agentId,
        checkoutRunId,
        id,
      );
      if (!ensuredRun) {
        res.status(400).json({ error: "Invalid run id", details: "Run id must be a valid UUID" });
        return;
      }
    }
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    const actorTypeForWake = pCheckout?.type === "agent" ? "agent" : "board";
    if (
      shouldWakeAssigneeOnCheckout({
        actorType: actorTypeForWake,
        actorAgentId: pCheckout?.type === "agent" ? pCheckout.id ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyPermission(db, req, existing.companyId, "issues:write");
    if (!(await ctx.assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = ctx.requireAgentRunId(req, res);
    const pRelease = getCurrentPrincipal(req);
    if (pRelease?.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      pRelease?.type === "agent" ? pRelease.id : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });
}
