import type { Router } from "express";
import type { IssueRoutesContext } from "./context.js";

export function registerIssueRouteParams(router: Router, ctx: IssueRoutesContext): void {
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await ctx.normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await ctx.normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });
}
