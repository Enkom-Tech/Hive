import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const header = `import type { Router, Request } from "express";
import type { Db } from "@hive/db";
import { companies } from "@hive/db";
import { eq } from "drizzle-orm";
import {
  createAgentHireSchema,
  createAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  updateAgentSchema,
  AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY,
} from "@hive/shared";
import { validate } from "../../middleware/validate.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { forbidden } from "../../errors.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { redactEventPayload } from "../../redaction.js";
import {
  assertCanCreateAgentsForCompany,
  assertCanUpdateAgent,
  parseSourceIssueIds,
  type AgentRoutesCommonDeps,
} from "./common.js";
import { logActivity } from "../../services/index.js";
import {
  asRecord,
  asNonEmptyString,
  applyCreateDefaultsByAdapterType,
  DEFAULT_INSTRUCTIONS_PATH_KEYS,
  KNOWN_INSTRUCTIONS_PATH_KEYS,
  mergeAdapterConfigPreservingExistingEnv,
  resolveInstructionsFilePath,
  summarizeAgentUpdateDetails,
} from "./route-shared.js";

export type AgentCrudRoutesDeps = {
  db: Db;
  svc: ReturnType<typeof import("../../services/index.js").agentService>;
  secretsSvc: ReturnType<typeof import("../../services/index.js").secretService>;
  strictSecretsMode: boolean;
  commonDeps: AgentRoutesCommonDeps;
  approvalsSvc: ReturnType<typeof import("../../services/approvals.js").approvalService>;
  issueApprovalsSvc: ReturnType<typeof import("../../services/issue-approvals.js").issueApprovalService>;
  heartbeat: ReturnType<typeof import("../../services/index.js").heartbeatService>;
};

export function registerAgentCrudRoutes(router: Router, deps: AgentCrudRoutesDeps): void {
  const { db, svc, secretsSvc, strictSecretsMode, commonDeps, approvalsSvc, issueApprovalsSvc, heartbeat } = deps;

  async function assertCanManageInstructionsPath(
    req: Request,
    targetAgent: { id: string; companyId: string },
  ) {
    await assertCompanyRead(db, req, targetAgent.companyId);
    const p = getCurrentPrincipal(req);
    if (p?.type === "user" || p?.type === "system") return;
    if (!p?.id || p?.type !== "agent") throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(p.id);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.id === targetAgent.id) return;
    const chainOfCommand = await svc.getChainOfCommand(targetAgent.id);
    if (chainOfCommand.some((manager) => manager.id === actorAgent.id)) return;
    throw forbidden("Only the target agent or an ancestor manager can update instructions path");
  }

`;

const body = fs.readFileSync(path.join(__dirname, "_crud_body.ts"), "utf8");
const out = header + body + "\n}\n";
fs.writeFileSync(path.join(__dirname, "crud-routes.ts"), out);
fs.unlinkSync(path.join(__dirname, "_crud_body.ts"));
fs.unlinkSync(path.join(__dirname, "_build-crud.mjs"));
