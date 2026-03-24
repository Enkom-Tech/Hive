import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Generates a per-request nonce for CSP script-src and style-src so we can avoid 'unsafe-inline'.
 * Must run before Helmet so res.locals.cspNonce is set when CSP is applied.
 */
export const cspNonceMiddleware: RequestHandler = (_req, res, next) => {
  res.locals.cspNonce = randomBytes(32).toString("hex");
  next();
};

/**
 * Ensures every `<script ...>` opening tag has a `nonce` matching Helmet `script-src`.
 * Vite's HTML transform is supposed to do this via `html.cspNonce`, but in middleware mode
 * some injected inline scripts (React refresh preamble, dev client) can still be emitted
 * without a nonce, which breaks strict CSP.
 */
export function ensureCspNonceOnScriptOpeningTags(html: string, nonce: string): string {
  if (!nonce) return html;
  return html.replace(/<script\b([^>]*?)>/gi, (full, attrs: string) => {
    if (/\bnonce\s*=/.test(attrs)) return full;
    return `<script nonce="${nonce}"${attrs}>`;
  });
}
