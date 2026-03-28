import type { Router } from "express";
import type { Db } from "@hive/db";
import { testAdapterEnvironmentSchema } from "@hive/shared";
import { validate } from "../../middleware/validate.js";
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

export function registerAgentAdaptersRoutes(router: Router, deps: AgentAdaptersRoutesDeps): void {
  const { db, secretsSvc, strictSecretsMode, commonDeps } = deps;

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const type = req.params.type as string;
    const models = await listAdapterModels(type);
    res.json(models);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = req.params.type as string;
      await assertCanCreateAgentsForCompany(req, companyId, commonDeps);
      const adapter = findServerAdapter(type);
      if (!adapter) {
        res.status(404).json({ error: `Unknown adapter type: ${type}` });
        return;
      }
      const inputAdapterConfig = (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
      );
      const result = await adapter.testEnvironment({
        companyId,
        adapterType: type,
        config: runtimeAdapterConfig,
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/adapters", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyRead(db, req, companyId);
    const adapters = listServerAdapters().map((a) => ({
      type: a.type,
      label: a.type.replace(/_/g, " "),
      agentConfigurationDoc: a.agentConfigurationDoc ?? null,
    }));
    res.json({ adapters });
  });
}
