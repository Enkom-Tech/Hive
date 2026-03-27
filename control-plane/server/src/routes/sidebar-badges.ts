import { Router } from "express";
import type { Db } from "@hive/db";
import { and, eq, sql } from "drizzle-orm";
import { joinRequests } from "@hive/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { getCurrentPrincipal } from "../auth/principal.js";
import { assertCompanyRead } from "./authz.js";

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);

  router.get("/companies/:companyId/sidebar-badges", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const p = getCurrentPrincipal(req);
    let canApproveJoins = false;
    if (p?.type === "user" || p?.type === "system") {
      canApproveJoins =
        p.type === "system" ||
        Boolean(p.roles?.includes("instance_admin")) ||
        (await access.canUser(companyId, p.id, "joins:approve"));
    } else if (p?.type === "agent" && p.id) {
      canApproveJoins = await access.hasPermission(companyId, "agent", p.id, "joins:approve");
    }

    const joinRequestCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(joinRequests)
      .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
      .then((rows) => Number(rows[0]?.count ?? 0));

    const badges = await svc.get(companyId, {
      joinRequests: joinRequestCount,
    });
    const summary = await dashboard.summary(companyId);
    const hasFailedRuns = badges.failedRuns > 0;
    const alertsCount =
      (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
      (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
    badges.inbox = badges.failedRuns + alertsCount + joinRequestCount + badges.approvals;

    res.json({ ...badges, canApproveJoinRequests: canApproveJoins });
  });

  return router;
}
