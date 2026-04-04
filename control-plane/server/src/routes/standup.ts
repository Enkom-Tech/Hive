import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { standupService } from "../services/standup.js";
import { assertCompanyRead } from "./authz.js";

export async function standupPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = standupService(db);

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/standup",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await svc.getReport(companyId));
    },
  );
}
