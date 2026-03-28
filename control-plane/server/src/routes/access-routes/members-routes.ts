import type { Router } from "express";
import type { Db } from "@hive/db";
import { updateMemberPermissionsSchema } from "@hive/shared";
import { notFound } from "../../errors.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import { assertCompanyPermission } from "../authz.js";

export type MembersRoutesDeps = {
  db: Db;
  access: ReturnType<typeof import("../../services/access.js").accessService>;
};

export function registerMembersRoutes(router: Router, deps: MembersRoutesDeps): void {
  const { db, access } = deps;

  router.get("/companies/:companyId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(db, req, companyId, "users:manage_permissions");
    const members = await access.listMembers(companyId);
    res.json(members);
  });

  router.patch(
    "/companies/:companyId/members/:memberId/permissions",
    validate(updateMemberPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(db, req, companyId, "users:manage_permissions");
      const updated = await access.setMemberPermissions(
        companyId,
        memberId,
        req.body.grants ?? [],
        getCurrentPrincipal(req)?.id ?? null
      );
      if (!updated) throw notFound("Member not found");
      res.json(updated);
    }
  );
}
