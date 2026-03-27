import type { Request } from "express";
import type { Principal } from "@hive/shared";
import { unauthorized } from "../errors.js";
import { LOCAL_BOARD_USER_ID } from "../board-claim.js";

export function getCurrentPrincipal(req: Request): Principal | null {
  return req.principal ?? null;
}

export function requirePrincipal(req: Request): Principal {
  const p = getCurrentPrincipal(req);
  if (!p) throw unauthorized();
  return p;
}

/** True for legacy system principal or the persisted local_trusted board user (`local-board`). */
export function isLocalImplicit(req: Request): boolean {
  const p = getCurrentPrincipal(req);
  if (p?.type === "system") return true;
  return p?.type === "user" && p.id === LOCAL_BOARD_USER_ID;
}
