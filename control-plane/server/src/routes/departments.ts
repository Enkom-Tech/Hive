import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "@hive/db";
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  upsertDepartmentMembershipSchema,
  listDepartmentMembershipsQuerySchema,
} from "@hive/shared";
import { forbidden, unauthorized, unprocessable } from "../errors.js";
import { accessService, agentService, departmentService, logActivity } from "../services/index.js";
import { assertCompanyRead, getActorInfo } from "./authz.js";

export async function departmentsPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const departmentsSvc = departmentService(db);
  const access = accessService(db);
  const agentsSvc = agentService(db);

  async function assertCanManageDepartmentsFastify(req: FastifyRequest, companyId: string) {
    await assertCompanyRead(db, req, companyId);
    const p = req.principal;
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

  async function assertCanAssignMembersFastify(req: FastifyRequest, companyId: string) {
    await assertCompanyRead(db, req, companyId);
    const p = req.principal;
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

  async function assertAssignablePrincipal(companyId: string, principalType: "user" | "agent", principalId: string) {
    if (principalType === "agent") {
      const agent = await agentsSvc.getById(principalId);
      if (!agent || agent.companyId !== companyId) throw unprocessable("Agent is not part of this company");
      return;
    }
    const membership = await access.getMembership(companyId, "user", principalId);
    if (!membership || membership.status !== "active") throw unprocessable("User is not an active company member");
  }

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/departments",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await departmentsSvc.list(companyId));
    },
  );

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/departments",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCanManageDepartmentsFastify(req, companyId);
      const parsed = createDepartmentSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const created = await departmentsSvc.create(companyId, parsed.data);
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
      return reply.status(201).send(created);
    },
  );

  fastify.patch<{ Params: { companyId: string; departmentId: string } }>(
    "/api/companies/:companyId/departments/:departmentId",
    async (req, reply) => {
      const { companyId, departmentId } = req.params;
      await assertCanManageDepartmentsFastify(req, companyId);
      const parsed = updateDepartmentSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      const updated = await departmentsSvc.update(companyId, departmentId, parsed.data);
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
        details: parsed.data,
      });
      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { companyId: string; departmentId: string } }>(
    "/api/companies/:companyId/departments/:departmentId",
    async (req, reply) => {
      const { companyId, departmentId } = req.params;
      await assertCanManageDepartmentsFastify(req, companyId);
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
      return reply.send({ ok: true });
    },
  );

  fastify.get<{ Params: { companyId: string; departmentId: string }; Querystring: Record<string, unknown> }>(
    "/api/companies/:companyId/departments/:departmentId/memberships",
    async (req, reply) => {
      const { companyId, departmentId } = req.params;
      await assertCompanyRead(db, req, companyId);
      const parsed = listDepartmentMembershipsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
      let rows = await departmentsSvc.listMemberships(companyId, departmentId);
      if (parsed.data.principalType) rows = rows.filter((row) => row.principalType === parsed.data.principalType);
      if (parsed.data.principalId) rows = rows.filter((row) => row.principalId === parsed.data.principalId);
      return reply.send(rows);
    },
  );

  fastify.put<{ Params: { companyId: string; departmentId: string } }>(
    "/api/companies/:companyId/departments/:departmentId/memberships",
    async (req, reply) => {
      const { companyId, departmentId } = req.params;
      await assertCanAssignMembersFastify(req, companyId);
      const parsed = upsertDepartmentMembershipSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });
      await assertAssignablePrincipal(companyId, parsed.data.principalType, parsed.data.principalId);
      const row = await departmentsSvc.upsertMembership({
        companyId,
        departmentId,
        principalType: parsed.data.principalType,
        principalId: parsed.data.principalId,
        isPrimary: parsed.data.isPrimary,
        status: parsed.data.status,
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
        details: { principalType: row.principalType, principalId: row.principalId, status: row.status, isPrimary: row.isPrimary },
      });
      return reply.send(row);
    },
  );

  fastify.delete<{ Params: { companyId: string; departmentId: string }; Querystring: Record<string, string> }>(
    "/api/companies/:companyId/departments/:departmentId/memberships",
    async (req, reply) => {
      const { companyId, departmentId } = req.params;
      await assertCanAssignMembersFastify(req, companyId);
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
      return reply.send({ ok: true });
    },
  );
}
