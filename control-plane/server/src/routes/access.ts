import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import { forbidden, unauthorized } from "../errors.js";
import { accessService, agentService, secretService } from "../services/index.js";
import { registerBoardClaimRoutesF } from "./access-routes/board-claim-routes.js";
import { registerSkillsRoutesF } from "./access-routes/skills-routes.js";
import { registerInviteRoutesF } from "./access-routes/invite-routes.js";
import { registerJoinRoutesF } from "./access-routes/join-routes.js";
import { registerMembersRoutesF } from "./access-routes/members-routes.js";
import { registerAdminAccessRoutesF } from "./access-routes/admin-access-routes.js";

export { companyInviteExpiresAt } from "./access-routes/helpers/tokens.js";
export {
  buildJoinDefaultsPayloadForAccept,
  mergeJoinDefaultsPayloadForReplay,
  normalizeAgentDefaultsForJoin,
} from "./access-routes/helpers/join-payload.js";
export { buildInviteOnboardingTextDocument } from "./access-routes/helpers/onboarding.js";
export { resolveJoinRequestAgentManagerId } from "./access-routes/helpers/join-shared.js";

export async function accessPlugin(
  fastify: FastifyInstance,
  opts: {
    db: Db;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
    joinAllowedAdapterTypes?: string[];
  },
): Promise<void> {
  const { db } = opts;
  const access = accessService(db);
  const agents = agentService(db);
  const secretsSvc = secretService(db);
  const joinAllowedAdapterTypes = opts.joinAllowedAdapterTypes && opts.joinAllowedAdapterTypes.length > 0 ? opts.joinAllowedAdapterTypes : null;

  async function assertInstanceAdminF(req: import("./authz.js").PrincipalCarrier): Promise<void> {
    const p = req.principal ?? null;
    if (p?.type !== "user" && p?.type !== "system") throw unauthorized();
    if (p?.type === "system") return;
    if (p?.roles?.includes("instance_admin")) return;
    const allowed = await access.isInstanceAdmin(p?.id ?? "");
    if (!allowed) throw forbidden("Instance admin required");
  }

  registerSkillsRoutesF(fastify);
  registerBoardClaimRoutesF(fastify, db);
  registerMembersRoutesF(fastify, { db, access });
  registerAdminAccessRoutesF(fastify, { access, assertInstanceAdmin: assertInstanceAdminF });
  registerInviteRoutesF(fastify, {
    db,
    opts: { deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure, bindHost: opts.bindHost, allowedHostnames: opts.allowedHostnames },
    access,
    agents,
    secretsSvc,
    joinAllowedAdapterTypes,
    assertInstanceAdmin: assertInstanceAdminF,
  });
  registerJoinRoutesF(fastify, {
    db,
    access,
    agents,
    secretsSvc,
    joinAllowedAdapterTypes,
  });
}
