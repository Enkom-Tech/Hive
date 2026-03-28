import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/src/routes");
const accessPath = path.join(dir, "access.ts");
const lines = fs.readFileSync(accessPath, "utf8").split(/\r?\n/);

/** 1-based line numbers inclusive */
function sliceLines(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

const inviteInner = sliceLines(113, 678);
const joinInner = sliceLines(680, 1000);
const membersInner = sliceLines(1002, 1067);

const inviteHeader = `import type { Router } from "express";
import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { invites, joinRequests } from "@hive/db";
import {
  acceptInviteSchema,
  createCompanyInviteSchema,
  inviteTestResolutionQuerySchema,
} from "@hive/shared";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import {
  conflict,
  notFound,
  unauthorized,
  badRequest,
  unprocessable,
} from "../../errors.js";
import { getCurrentPrincipal, isLocalImplicit } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import {
  agentService,
  deduplicateAgentName,
  logActivity,
  secretService,
} from "../../services/index.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { assertCompanyPermission } from "../authz.js";
import {
  hashToken,
  createInviteToken,
  createClaimSecret,
  companyInviteExpiresAt,
  INVITE_TOKEN_MAX_RETRIES,
  isInviteTokenHashCollisionError,
} from "./helpers/tokens.js";
import {
  buildJoinDefaultsPayloadForAccept,
  mergeJoinDefaultsPayloadForReplay,
  normalizeAgentDefaultsForJoin,
  isPlainObject,
  type JoinDiagnostic,
} from "./helpers/join-payload.js";
import {
  buildInviteOnboardingManifest,
  buildInviteOnboardingTextDocument,
  mergeInviteDefaults,
  toInviteSummaryResponse,
} from "./helpers/onboarding.js";
import {
  inviteExpired,
  probeInviteResolutionTarget,
  requestIp,
  resolveActorEmail,
  resolveJoinRequestAgentManagerId,
  toJoinRequestResponse,
} from "./helpers/join-shared.js";

export type InviteRoutesDeps = {
  db: Db;
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  };
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  agents: ReturnType<typeof agentService>;
  secretsSvc: ReturnType<typeof secretService>;
  joinAllowedAdapterTypes: string[] | null;
  assertInstanceAdmin: (req: Request) => Promise<void>;
};

export function registerInviteRoutes(router: Router, deps: InviteRoutesDeps): void {
  const { db, opts, access, agents, secretsSvc, joinAllowedAdapterTypes, assertInstanceAdmin } = deps;

`;

const inviteFooter = "\n}\n";

const joinHeader = `import type { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentApiKeys, invites, joinRequests } from "@hive/db";
import {
  claimJoinRequestApiKeySchema,
  listJoinRequestsQuerySchema,
} from "@hive/shared";
import {
  conflict,
  forbidden,
  notFound,
  badRequest,
  unprocessable,
} from "../../errors.js";
import { getCurrentPrincipal, isLocalImplicit } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import {
  agentService,
  deduplicateAgentName,
  logActivity,
  notifyHireApproved,
  secretService,
} from "../../services/index.js";
import { assertAdapterTypeAllowed, validateAdapterConfig } from "../../adapters/index.js";
import { assertCompanyPermission, assertCompanyRead } from "../authz.js";
import { hashToken, tokenHashesMatch } from "./helpers/tokens.js";
import {
  grantsFromDefaults,
  resolveJoinRequestAgentManagerId,
  toJoinRequestResponse,
} from "./helpers/join-shared.js";

export type JoinRoutesDeps = {
  db: Db;
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  agents: ReturnType<typeof agentService>;
  secretsSvc: ReturnType<typeof secretService>;
  joinAllowedAdapterTypes: string[] | null;
};

export function registerJoinRoutes(router: Router, deps: JoinRoutesDeps): void {
  const { db, access, agents, secretsSvc, joinAllowedAdapterTypes } = deps;

`;

const membersHeader = `import type { Router } from "express";
import type { Request } from "express";
import type { Db } from "@hive/db";
import { updateMemberPermissionsSchema, updateUserCompanyAccessSchema } from "@hive/shared";
import { notFound } from "../../errors.js";
import { getCurrentPrincipal } from "../../auth/principal.js";
import { validate } from "../../middleware/validate.js";
import { assertCompanyPermission } from "../authz.js";

export type MembersAdminRoutesDeps = {
  db: Db;
  access: ReturnType<typeof import("../../services/access.js").accessService>;
  assertInstanceAdmin: (req: Request) => Promise<void>;
};

export function registerMembersAdminRoutes(router: Router, deps: MembersAdminRoutesDeps): void {
  const { db, access, assertInstanceAdmin } = deps;

`;

fs.writeFileSync(path.join(dir, "access-routes/invite-routes.ts"), inviteHeader + inviteInner + inviteFooter);
fs.writeFileSync(path.join(dir, "access-routes/join-routes.ts"), joinHeader + joinInner + inviteFooter);
fs.writeFileSync(path.join(dir, "access-routes/members-admin-routes.ts"), membersHeader + membersInner + inviteFooter);

console.log("wrote invite, join, members-admin route files");
