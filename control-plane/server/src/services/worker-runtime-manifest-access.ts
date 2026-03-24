import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import { droneProvisioningTokens } from "@hive/db";
import type { Principal } from "@hive/shared";
import { getCurrentPrincipal } from "../auth/principal.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function principalMayAccessCompany(p: Principal | null | undefined, companyId: string): boolean {
  if (!p) return false;
  if (p.type === "agent") return p.company_id === companyId;
  if (p.type === "system") return true;
  if (p.type === "user") {
    if (p.roles.includes("instance_admin")) return true;
    return (p.company_ids ?? []).includes(companyId);
  }
  return false;
}

/**
 * Who may read GET .../worker-runtime/manifest: board (company access), agent (same company),
 * or valid unconsumed drone provisioning token for that company.
 */
export async function canReadCompanyWorkerRuntimeManifest(
  db: Db,
  req: Request,
  companyId: string,
): Promise<boolean> {
  const p = getCurrentPrincipal(req);
  if (p?.type === "agent" && p.company_id === companyId) {
    return true;
  }
  if (principalMayAccessCompany(p, companyId)) {
    return true;
  }

  const authHeader = req.header("authorization");
  if (!authHeader?.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const token = authHeader.slice("bearer ".length).trim();
  if (!token.startsWith("hive_dpv_")) {
    return false;
  }

  const row = await db
    .select({ id: droneProvisioningTokens.id })
    .from(droneProvisioningTokens)
    .where(
      and(
        eq(droneProvisioningTokens.tokenHash, hashToken(token)),
        eq(droneProvisioningTokens.companyId, companyId),
        isNull(droneProvisioningTokens.consumedAt),
        gt(droneProvisioningTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row != null;
}
