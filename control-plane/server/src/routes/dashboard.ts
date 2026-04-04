import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyRead } from "./authz.js";

export async function dashboardPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = dashboardService(db);

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/dashboard",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await svc.summary(companyId));
    },
  );
}
