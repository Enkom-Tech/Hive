import type { Request, RequestHandler } from "express";
import { getCurrentPrincipal } from "../auth/principal.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
];

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function trustedOriginsForRequest(req: Request) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
  const host = req.header("host")?.trim();
  if (host) {
    origins.add(`http://${host}`.toLowerCase());
    origins.add(`https://${host}`.toLowerCase());
  }
  return origins;
}

function isTrustedBoardMutationRequest(req: Request) {
  const allowedOrigins = trustedOriginsForRequest(req);
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const p = getCurrentPrincipal(req);
    const isBoard = p?.type === "user" || p?.type === "system";
    if (!isBoard) {
      next();
      return;
    }

    // System principal (local_trusted) uses implicit board for localhost-only development.
    // In this mode, origin/referer headers can be omitted by some clients for multipart
    // uploads; do not block those mutations.
    if (p.type === "system") {
      next();
      return;
    }

    if (!isTrustedBoardMutationRequest(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
