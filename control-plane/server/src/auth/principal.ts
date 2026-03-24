import type { Request } from "express";
import type { Principal } from "@hive/shared";
import { unauthorized } from "../errors.js";

export function getCurrentPrincipal(req: Request): Principal | null {
  return req.principal ?? null;
}

export function requirePrincipal(req: Request): Principal {
  const p = getCurrentPrincipal(req);
  if (!p) throw unauthorized();
  return p;
}

/** True when the principal is the local trusted system (local_trusted mode). */
export function isLocalImplicit(req: Request): boolean {
  return getCurrentPrincipal(req)?.type === "system";
}
