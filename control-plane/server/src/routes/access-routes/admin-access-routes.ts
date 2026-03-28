import type { Router } from "express";
import type { Request } from "express";
import { updateUserCompanyAccessSchema } from "@hive/shared";
import { notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";

export type AdminAccessRoutesDeps = {
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  assertInstanceAdmin: (req: Request) => Promise<void>;
};

export function registerAdminAccessRoutes(router: Router, deps: AdminAccessRoutesDeps): void {
  const { access, assertInstanceAdmin } = deps;

  router.post("/admin/users/:userId/promote-instance-admin", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const result = await access.promoteInstanceAdmin(userId);
    res.status(201).json(result);
  });

  router.post("/admin/users/:userId/demote-instance-admin", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const removed = await access.demoteInstanceAdmin(userId);
    if (!removed) throw notFound("Instance admin role not found");
    res.json(removed);
  });

  router.get("/admin/users/:userId/company-access", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const memberships = await access.listUserCompanyAccess(userId);
    res.json(memberships);
  });

  router.put(
    "/admin/users/:userId/company-access",
    validate(updateUserCompanyAccessSchema),
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const memberships = await access.setUserCompanyAccess(userId, req.body.companyIds ?? []);
      res.json(memberships);
    }
  );
}
