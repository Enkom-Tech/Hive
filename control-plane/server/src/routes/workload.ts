import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { workloadService } from "../services/workload.js";
import { assertCompanyRead } from "./authz.js";

export async function workloadPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const svc = workloadService(db);

  fastify.get<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/workload",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyRead(db, req, companyId);
      return reply.send(await svc.getWorkload(companyId));
    },
  );
}
