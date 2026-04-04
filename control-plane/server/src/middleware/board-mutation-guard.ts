import type { IncomingMessage } from "node:http";
import type { Principal } from "@hive/shared";
import { getCurrentPrincipal, isLocalImplicit } from "../auth/principal.js";

interface HttpResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(data?: string): void;
}

type NodeMiddleware = (req: IncomingMessage, res: HttpResponse, next: (err?: unknown) => void) => void;

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

function trustedOriginsForRequest(req: IncomingMessage) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
  const host = (req.headers["host"] ?? "").trim();
  if (host) {
    origins.add(`http://${host}`.toLowerCase());
    origins.add(`https://${host}`.toLowerCase());
  }
  return origins;
}

function isTrustedBoardMutationRequest(req: IncomingMessage) {
  const allowedOrigins = trustedOriginsForRequest(req);
  const origin = parseOrigin(req.headers["origin"] as string | undefined);
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.headers["referer"] as string | undefined);
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

export function boardMutationGuard(): NodeMiddleware {
  return (req, res, next) => {
    if (SAFE_METHODS.has((req.method ?? "").toUpperCase())) {
      next();
      return;
    }

    const p = getCurrentPrincipal(req as IncomingMessage & { principal?: Principal | null });
    const isBoard = p?.type === "user" || p?.type === "system";
    if (!isBoard) {
      next();
      return;
    }

    // Local trusted board (legacy system or persisted `local-board` user): localhost-only;
    // origin/referer may be omitted for multipart uploads.
    if (isLocalImplicit(req as IncomingMessage & { principal?: Principal | null })) {
      next();
      return;
    }

    if (!isTrustedBoardMutationRequest(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Board mutation requires trusted browser origin" }));
      return;
    }

    next();
  };
}
