import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { testAdapterEnvironmentSchema } from "@hive/shared";
import { assertCompanyRead } from "../authz.js";
import { findServerAdapter, listAdapterModels, listServerAdapters } from "../../adapters/index.js";
import {
  assertCanCreateAgentsForCompany,
  type AgentRoutesCommonDeps,
} from "./common.js";

export type AgentAdaptersRoutesDeps = {
  db: Db;
  secretsSvc: ReturnType<typeof import("../../services/index.js").secretService>;
  strictSecretsMode: boolean;
  commonDeps: AgentRoutesCommonDeps;
};

export function registerAgentAdaptersRoutesF(fastify: FastifyInstance, deps: AgentAdaptersRoutesDeps): void {
  const { db, secretsSvc, strictSecretsMode, commonDeps } = deps;

  fastify.get<{ Params: { companyId: string; type: string } }>("/api/companies/:companyId/adapters/:type/models", async (req, reply) => {
    const { companyId, type } = req.params;
    await assertCompanyRead(db, req, companyId);
    return reply.send(await listAdapterModels(type));
  });

  fastify.post<{ Params: { companyId: string; type: string } }>("/api/companies/:companyId/adapters/:type/test-environment", async (req, reply) => {
    const { companyId, type } = req.params;
    const parsed = testAdapterEnvironmentSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
    const adapter = findServerAdapter(type);
    if (!adapter) return reply.status(404).send({ error: `Unknown adapter type: ${type}` });
    const inputAdapterConfig = (parsed.data as { adapterConfig?: Record<string, unknown> }).adapterConfig ?? {};
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(companyId, inputAdapterConfig, { strictMode: strictSecretsMode });
    const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(companyId, normalizedAdapterConfig);
    const result = await adapter.testEnvironment({ companyId, adapterType: type, config: runtimeAdapterConfig });
    return reply.send(result);
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/adapters", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    const adapters = listServerAdapters().map((a) => ({ type: a.type, label: a.type.replace(/_/g, " "), agentConfigurationDoc: a.agentConfigurationDoc ?? null }));
    return reply.send({ adapters });
  });
}
