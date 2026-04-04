import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { updateMemberPermissionsSchema } from "@hive/shared";
import { notFound } from "../../errors.js";
import { assertCompanyPermission } from "../authz.js";

export type MembersRoutesDeps = {
  db: Db;
  access: ReturnType<typeof import("../../services/access.js").accessService>;
};

export function registerMembersRoutesF(fastify: FastifyInstance, deps: MembersRoutesDeps): void {
  const { db, access } = deps;

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/members", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "users:manage_permissions");
    return reply.send(await access.listMembers(companyId));
  });

  fastify.patch<{ Params: { companyId: string; memberId: string } }>("/api/companies/:companyId/members/:memberId/permissions", async (req, reply) => {
    const { companyId, memberId } = req.params;
    await assertCompanyPermission(db, req, companyId, "users:manage_permissions");
    const parsed = updateMemberPermissionsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as { grants?: unknown[] };
    const p = req.principal ?? null;
    const updated = await access.setMemberPermissions(companyId, memberId, (body.grants ?? []) as Parameters<typeof access.setMemberPermissions>[2], p?.id ?? null);
    if (!updated) throw notFound("Member not found");
    return reply.send(updated);
  });
}
