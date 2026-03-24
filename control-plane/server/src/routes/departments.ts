import { Router, type Request } from "express";
import type { Db } from "@hive/db";
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  upsertDepartmentMembershipSchema,
  listDepartmentMembershipsQuerySchema,
} from "@hive/shared";
import { getCurrentPrincipal } from "../auth/principal.js";
import { forbidden, unauthorized, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, departmentService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function departmentRoutes(db: Db) {
  const router = Router();
  const departmentsSvc = departmentService(db);
  const access = accessService(db);
  const agentsSvc = agentService(db);

  async function assertCanManageDepartments(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const p = getCurrentPrincipal(req);
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return;
    if (p?.type === "user") {
      const allowed =
        (await access.canUser(companyId, p.id ?? "", "departments:manage")) ||
        (await access.canUser(companyId, p.id ?? "", "users:manage_permissions"));
      if (allowed) return;
      throw forbidden("Missing permission: departments:manage");
    }
    if (p?.type === "agent") {
      if (!p.id) throw unauthorized();
      const allowed = await access.hasPermission(companyId, "agent", p.id, "departments:manage");
      if (allowed) return;
      throw forbidden("Missing permission: departments:manage");
    }
    throw unauthorized();
  }

  async function assertCanAssignMembers(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const p = getCurrentPrincipal(req);
    if (p?.type === "system" || p?.roles?.includes("instance_admin")) return;
    if (p?.type === "user") {
      const allowed = await access.canUser(companyId, p.id ?? "", "departments:assign_members");
      if (allowed) return;
      throw forbidden("Missing permission: departments:assign_members");
    }
    if (p?.type === "agent") {
      if (!p.id) throw unauthorized();
      const allowed = await access.hasPermission(companyId, "agent", p.id, "departments:assign_members");
      if (allowed) return;
      throw forbidden("Missing permission: departments:assign_members");
    }
    throw unauthorized();
  }

  async function assertAssignablePrincipal(
    companyId: string,
    principalType: "user" | "agent",
    principalId: string,
  ) {
    if (principalType === "agent") {
      const agent = await agentsSvc.getById(principalId);
      if (!agent || agent.companyId !== companyId) throw unprocessable("Agent is not part of this company");
      return;
    }
    const membership = await access.getMembership(companyId, "user", principalId);
    if (!membership || membership.status !== "active") {
      throw unprocessable("User is not an active company member");
    }
  }

  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await departmentsSvc.list(companyId);
    res.json(rows);
  });

  router.post("/companies/:companyId/departments", validate(createDepartmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDepartments(req, companyId);
    const created = await departmentsSvc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "department.created",
      entityType: "department",
      entityId: created.id,
      details: { name: created.name, slug: created.slug },
    });
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/departments/:departmentId", validate(updateDepartmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const departmentId = req.params.departmentId as string;
    await assertCanManageDepartments(req, companyId);
    const updated = await departmentsSvc.update(companyId, departmentId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "department.updated",
      entityType: "department",
      entityId: updated.id,
      details: req.body,
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/departments/:departmentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const departmentId = req.params.departmentId as string;
    await assertCanManageDepartments(req, companyId);
    const removed = await departmentsSvc.remove(companyId, departmentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "department.deleted",
      entityType: "department",
      entityId: departmentId,
      details: { removed: Boolean(removed) },
    });
    res.json({ ok: true });
  });

  router.get("/companies/:companyId/departments/:departmentId/memberships", async (req, res) => {
      const companyId = req.params.companyId as string;
      const departmentId = req.params.departmentId as string;
      assertCompanyAccess(req, companyId);
      const parsed = listDepartmentMembershipsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      let rows = await departmentsSvc.listMemberships(companyId, departmentId);
      if (q.principalType) rows = rows.filter((row) => row.principalType === q.principalType);
      if (q.principalId) rows = rows.filter((row) => row.principalId === q.principalId);
      res.json(rows);
  });

  router.put(
    "/companies/:companyId/departments/:departmentId/memberships",
    validate(upsertDepartmentMembershipSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const departmentId = req.params.departmentId as string;
      await assertCanAssignMembers(req, companyId);
      await assertAssignablePrincipal(companyId, req.body.principalType, req.body.principalId);
      const row = await departmentsSvc.upsertMembership({
        companyId,
        departmentId,
        principalType: req.body.principalType,
        principalId: req.body.principalId,
        isPrimary: req.body.isPrimary,
        status: req.body.status,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "department.membership_upserted",
        entityType: "department",
        entityId: departmentId,
        details: {
          principalType: row.principalType,
          principalId: row.principalId,
          status: row.status,
          isPrimary: row.isPrimary,
        },
      });
      res.json(row);
    },
  );

  router.delete("/companies/:companyId/departments/:departmentId/memberships", async (req, res) => {
    const companyId = req.params.companyId as string;
    const departmentId = req.params.departmentId as string;
    await assertCanAssignMembers(req, companyId);
    const principalType = String(req.query.principalType ?? "") as "user" | "agent";
    const principalId = String(req.query.principalId ?? "");
    if ((principalType !== "user" && principalType !== "agent") || !principalId.trim()) {
      throw unprocessable("principalType and principalId are required");
    }
    const removed = await departmentsSvc.removeMembership({
      companyId,
      departmentId,
      principalType,
      principalId: principalId.trim(),
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "department.membership_removed",
      entityType: "department",
      entityId: departmentId,
      details: { principalType, principalId: principalId.trim(), removed: Boolean(removed) },
    });
    res.json({ ok: true });
  });

  return router;
}
