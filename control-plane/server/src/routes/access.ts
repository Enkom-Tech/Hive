import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@hive/db";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import { forbidden, unauthorized } from "../errors.js";
import { getCurrentPrincipal, isLocalImplicit } from "../auth/principal.js";
import { accessService, agentService, secretService } from "../services/index.js";
import { registerBoardClaimRoutes } from "./access-routes/board-claim-routes.js";
import { registerSkillsRoutes } from "./access-routes/skills-routes.js";
import { registerInviteRoutes } from "./access-routes/invite-routes.js";
import { registerJoinRoutes } from "./access-routes/join-routes.js";
import { registerMembersRoutes } from "./access-routes/members-routes.js";
import { registerAdminAccessRoutes } from "./access-routes/admin-access-routes.js";

export { companyInviteExpiresAt } from "./access-routes/helpers/tokens.js";
export {
  buildJoinDefaultsPayloadForAccept,
  mergeJoinDefaultsPayloadForReplay,
  normalizeAgentDefaultsForJoin,
} from "./access-routes/helpers/join-payload.js";
export { buildInviteOnboardingTextDocument } from "./access-routes/helpers/onboarding.js";
export { resolveJoinRequestAgentManagerId } from "./access-routes/helpers/join-shared.js";

export function accessRoutes(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
    /** Optional: restricts which adapter types can be used for agent join requests. Omit or empty means all registry types allowed. */
    joinAllowedAdapterTypes?: string[];
  },
) {
  const router = Router();
  registerBoardClaimRoutes(router, db);
  registerSkillsRoutes(router);

  const access = accessService(db);
  const agents = agentService(db);
  const secretsSvc = secretService(db);
  const joinAllowedAdapterTypes =
    opts.joinAllowedAdapterTypes && opts.joinAllowedAdapterTypes.length > 0
      ? opts.joinAllowedAdapterTypes
      : null;

  async function assertInstanceAdmin(req: Request) {
    const p = getCurrentPrincipal(req);
    if (p?.type !== "user" && p?.type !== "system") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.isInstanceAdmin(p?.id ?? "");
    if (!allowed) throw forbidden("Instance admin required");
  }

  registerInviteRoutes(router, {
    db,
    opts,
    access,
    agents,
    secretsSvc,
    joinAllowedAdapterTypes,
    assertInstanceAdmin,
  });
  registerJoinRoutes(router, {
    db,
    access,
    agents,
    secretsSvc,
    joinAllowedAdapterTypes,
  });
  registerMembersRoutes(router, { db, access });
  registerAdminAccessRoutes(router, {
    access,
    assertInstanceAdmin,
  });

  return router;
}
