import type { Request, RequestHandler } from "express";
import type { Principal } from "@hive/shared";

export type PrincipalResolver = (req: Request) => Promise<Principal | null>;

export function createPrincipalMiddleware(resolver: PrincipalResolver): RequestHandler {
  return async (req, _res, next) => {
    try {
      req.principal = await resolver(req);
    } catch (err) {
      req.principal = null;
    }
    next();
  };
}

/** True when the request has a board-capable principal (user or system). */
export function isBoardPrincipal(req: Request): boolean {
  const p = req.principal;
  return p?.type === "user" || p?.type === "system";
}
