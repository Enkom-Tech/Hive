import helmet from "helmet";
import type { IncomingMessage, ServerResponse } from "node:http";

export type HelmetCspOptions = {
  /** Added to connect-src (e.g. Vite HMR ws/http on a separate port in middleware mode). */
  connectSrcExtras?: string[];
  /**
   * - strict: nonce-only script-src/style-src (API-only or tests).
   * - vite-dev: allow unsafe-inline + unsafe-eval for script and unsafe-inline for style so Vite + MDXEditor work.
   * - static-ui: strict scripts (nonce), relaxed styles (MDXEditor inline styles in production build).
   */
  cspProfile?: "strict" | "vite-dev" | "static-ui";
};

const nonceRef =
  (_req: IncomingMessage, res: ServerResponse) =>
  `'nonce-${(res as ServerResponse & { locals?: Record<string, unknown> }).locals?.cspNonce ?? ""}'`;

/**
 * Helmet with CSP. Default profile uses per-request nonces (cspNonceMiddleware) for script-src and style-src.
 */
export function createHelmet(opts: HelmetCspOptions = {}): ReturnType<typeof helmet> {
  const extras = opts.connectSrcExtras ?? [];
  const profile = opts.cspProfile ?? "strict";

  const sharedDirectives = {
    "default-src": ["'self'"],
    "connect-src": ["'self'", ...extras],
    "img-src": ["'self'", "data:"],
    "frame-ancestors": ["'none'"],
  } as const;

  if (profile === "vite-dev") {
    return helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          ...sharedDirectives,
          "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          // Vite's browser client creates an HMR ping worker from a blob: URL; without worker-src,
          // browsers fall back to script-src, which does not allow blob: (see client waitForSuccessfulPing).
          "worker-src": ["'self'", "blob:"],
        },
      },
    });
  }

  if (profile === "static-ui") {
    return helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          ...sharedDirectives,
          "script-src": ["'self'", nonceRef],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      },
    });
  }

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        ...sharedDirectives,
        "script-src": ["'self'", nonceRef],
        "style-src": ["'self'", nonceRef],
      },
    },
  });
}

/** Sets Permissions-Policy (Helmet does not include it). */
export const permissionsPolicyMiddleware = (
  _req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void => {
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
};
