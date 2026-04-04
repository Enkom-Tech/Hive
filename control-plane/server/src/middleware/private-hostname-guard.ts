import type { IncomingMessage, ServerResponse } from "node:http";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function extractHostname(req: IncomingMessage): string | null {
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const hostHeader = (req.headers["host"] ?? "").trim();
  const raw = forwardedHost || hostHeader;
  if (!raw) return null;

  try {
    return new URL(`http://${raw}`).hostname.trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalizeAllowedHostnames(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function resolvePrivateHostnameAllowSet(opts: { allowedHostnames: string[]; bindHost: string }): Set<string> {
  const configuredAllow = normalizeAllowedHostnames(opts.allowedHostnames);
  const bindHost = opts.bindHost.trim().toLowerCase();
  const allowSet = new Set<string>(configuredAllow);

  if (bindHost && bindHost !== "0.0.0.0") {
    allowSet.add(bindHost);
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  return allowSet;
}

function blockedHostnameMessage(hostname: string): string {
  return (
    `Hostname '${hostname}' is not allowed for this Hive instance. ` +
    `If you want to allow this hostname, please run pnpm hive allowed-hostname ${hostname}`
  );
}

type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

export function privateHostnameGuard(opts: {
  enabled: boolean;
  allowedHostnames: string[];
  bindHost: string;
}): NodeMiddleware {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const allowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  return (req, res, next) => {
    const hostname = extractHostname(req);
    const urlPath = req.url ?? "";
    const accept = req.headers["accept"] ?? "";
    const wantsJson = urlPath.startsWith("/api") || String(accept).includes("application/json");

    if (!hostname) {
      const error = "Missing Host header. If you want to allow a hostname, run pnpm hive allowed-hostname <host>.";
      if (wantsJson) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error }));
      } else {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end(error);
      }
      return;
    }

    if (isLoopbackHostname(hostname) || allowSet.has(hostname)) {
      next();
      return;
    }

    const error = blockedHostnameMessage(hostname);
    if (wantsJson) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error }));
    } else {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(error);
    }
  };
}
