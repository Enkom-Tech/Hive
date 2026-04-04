import type { FastifyInstance } from "fastify";
import { updateUserCompanyAccessSchema } from "@hive/shared";
import { notFound, forbidden, unauthorized } from "../../errors.js";
import type { PrincipalCarrier } from "../authz.js";

export type AdminAccessRoutesDeps = {
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  assertInstanceAdmin: (req: PrincipalCarrier) => Promise<void>;
};

async function assertInstanceAdminF(req: PrincipalCarrier, access: AdminAccessRoutesDeps["access"]): Promise<void> {
  const p = req.principal ?? null;
  if (p?.type !== "user" && p?.type !== "system") throw unauthorized();
  if (p?.type === "system") return;
  if (p?.roles?.includes("instance_admin")) return;
  const allowed = await access.isInstanceAdmin(p?.id ?? "");
  if (!allowed) throw forbidden("Instance admin required");
}

export function registerAdminAccessRoutesF(fastify: FastifyInstance, deps: AdminAccessRoutesDeps): void {
  const { access } = deps;

  fastify.post<{ Params: { userId: string } }>("/api/admin/users/:userId/promote-instance-admin", async (req, reply) => {
    await assertInstanceAdminF(req, access);
    const result = await access.promoteInstanceAdmin(req.params.userId);
    return reply.status(201).send(result);
  });

  fastify.post<{ Params: { userId: string } }>("/api/admin/users/:userId/demote-instance-admin", async (req, reply) => {
    await assertInstanceAdminF(req, access);
    const removed = await access.demoteInstanceAdmin(req.params.userId);
    if (!removed) throw notFound("Instance admin role not found");
    return reply.send(removed);
  });

  fastify.get<{ Params: { userId: string } }>("/api/admin/users/:userId/company-access", async (req, reply) => {
    await assertInstanceAdminF(req, access);
    return reply.send(await access.listUserCompanyAccess(req.params.userId));
  });

  fastify.put<{ Params: { userId: string } }>("/api/admin/users/:userId/company-access", async (req, reply) => {
    await assertInstanceAdminF(req, access);
    const parsed = updateUserCompanyAccessSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as { companyIds?: string[] };
    const memberships = await access.setUserCompanyAccess(req.params.userId, body.companyIds ?? []);
    return reply.send(memberships);
  });
}
