import type { Principal } from "@hive/shared";
import { unauthorized } from "../errors.js";
import { LOCAL_BOARD_USER_ID } from "../board-claim.js";

/** Minimal interface satisfied by both FastifyRequest and plain objects with a principal property. */
interface PrincipalHolder {
  principal?: Principal | null | undefined;
}

export function getCurrentPrincipal(req: PrincipalHolder): Principal | null {
  return req.principal ?? null;
}

export function requirePrincipal(req: PrincipalHolder): Principal {
  const p = getCurrentPrincipal(req);
  if (!p) throw unauthorized();
  return p;
}

/** True for legacy system principal or the persisted local_trusted board user (`local-board`). */
export function isLocalImplicit(req: PrincipalHolder): boolean {
  const p = getCurrentPrincipal(req);
  if (p?.type === "system") return true;
  return p?.type === "user" && p.id === LOCAL_BOARD_USER_ID;
}
