/// <reference path="./types/fastify.d.ts" />
/**
 * Fastify application factory.
 *
 * Mirrors the signature of createApp in app.ts so index.ts can switch between
 * implementations via the HIVE_USE_FASTIFY env flag.
 *
 * Phase 2: global middleware (CORS, CSP nonce, Helmet, rate-limit, body
 * parsing, principal, board-mutation-guard, sign-up gate, auth routes).
 * Phase 3: Express routes mounted via @fastify/middie adapter shim.
 * Phase 4: Vite / static UI.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyMiddie from "@fastify/middie";
import fastifyStatic from "@fastify/static";
import express, { Router } from "express";
import { count } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "@hive/db";
import { authUsers } from "@hive/db";
import type { DeploymentExposure, DeploymentMode, Principal } from "@hive/shared";
import type { StorageService } from "./storage/types.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { HttpError } from "./errors.js";
import { issueBoardJwt } from "./auth/board-jwt.js";
import { LOCAL_BOARD_USER_ID } from "./board-claim.js";
import { logger } from "./middleware/logger.js";
import { initPlacementPrometheus } from "./placement-metrics.js";
import { resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { applyUiBranding } from "./ui-branding.js";
import { ensureCspNonceOnScriptOpeningTags } from "./middleware/csp-nonce.js";
import { startPluginSupervisorRuntime } from "./services/plugin-supervisor.js";
import type { PrincipalResolver } from "./middleware/auth.js";
import { registerMainApiRoutes } from "./routes/register-main-api-routes.js";
import { llmRoutes } from "./routes/llms.js";
import { registerGithubWebhookBeforeJson } from "./routes/integrations-github.js";

export type UiMode = "none" | "static" | "vite-dev";

export type CreateAppOpts = {
  uiMode: UiMode;
  serverPort: number;
  storageService: StorageService;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  allowedHostnames: string[];
  bindHost: string;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  secretsStrictMode: boolean;
  secretsProvider: import("@hive/shared").SecretProvider;
  joinAllowedAdapterTypes: string[] | undefined;
  managedWorkerUrlAllowlist: string[] | undefined;
  corsAllowlist: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  metricsEnabled: boolean;
  drainAutoEvacuateEnabled: boolean;
  drainCancelInFlightPlacementsEnabled: boolean;
  vcsGitHubWebhookEnabled: boolean;
  vcsGitHubWebhookSecret: string | undefined;
  vcsGitHubAllowedRepos: string[] | undefined;
  workerIdentityAutomationEnabled?: boolean;
  apiPublicBaseUrl?: string;
  workerProvisionManifestJson?: string;
  workerProvisionManifestFile?: string;
  workerProvisionManifestSigningKeyPem?: string;
  internalHiveOperatorSecret?: string;
  pluginHostSecret?: string;
  e2eMcpSmokeMaterializeSecret?: string;
  bifrostAdminBaseUrl?: string;
  bifrostAdminToken?: string;
  authPublicBaseUrl?: string;
  authDisableSignUp: boolean;
  /**
   * Fastify path: the raw Better Auth instance, not an Express RequestHandler.
   * Passed through from bootstrap/auth.ts via betterAuthInstance.
   */
  betterAuthInstance?: unknown;
  /**
   * Express-style session resolver — used by the SSE handler and other Express
   * routes mounted via the middie adapter shim during Phase 3.
   */
  resolveSession?: ((req: import("express").Request) => Promise<BetterAuthSessionResult | null>) | undefined;
  /**
   * Fetch-style session resolver — used by Fastify-native auth hooks.
   */
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  principalResolver: PrincipalResolver;
  activeDatabaseConnectionString?: string;
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function isLoopbackBindHost(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "[::1]";
}

function viteDevHmrConnectSrc(hmrPort: number, bindHost: string): string[] {
  const hosts = new Set<string>(["127.0.0.1", "localhost"]);
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") hosts.add(bindHost);
  const urls: string[] = [];
  for (const host of hosts) {
    urls.push(`ws://${host}:${hmrPort}`, `http://${host}:${hmrPort}`);
  }
  return urls;
}

function parseBearerToken(raw: string | undefined): string | null {
  if (!raw || !raw.toLowerCase().startsWith("bearer ")) return null;
  const token = raw.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function isLoopbackHostname(hostname: string): boolean {
  const n = hostname.trim().toLowerCase();
  return n === "localhost" || n === "127.0.0.1" || n === "::1";
}

// ─── CSP helpers ──────────────────────────────────────────────────────────────

function attachNonce(reply: FastifyReply): string {
  const nonce = randomBytes(32).toString("hex");
  if (!reply.locals) (reply as unknown as { locals: Record<string, unknown> }).locals = {};
  reply.locals.cspNonce = nonce;
  return nonce;
}

function getNonce(reply: FastifyReply): string {
  return (reply.locals?.cspNonce as string) ?? "";
}

// ─── Board mutation guard (CSRF-ish) ─────────────────────────────────────────

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEV_ORIGINS = ["http://localhost:3100", "http://127.0.0.1:3100"];

function trustedOriginsForRequest(req: FastifyRequest): Set<string> {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((o) => o.toLowerCase()));
  const host = (req.headers.host ?? "").trim();
  if (host) {
    origins.add(`http://${host}`.toLowerCase());
    origins.add(`https://${host}`.toLowerCase());
  }
  return origins;
}

function parseOriginStr(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function isTrustedBoardMutation(req: FastifyRequest): boolean {
  const allowedOrigins = trustedOriginsForRequest(req);
  const origin = parseOriginStr(req.headers.origin as string | undefined);
  if (origin && allowedOrigins.has(origin)) return true;
  const referer = parseOriginStr(req.headers.referer as string | undefined);
  if (referer && allowedOrigins.has(referer)) return true;
  return false;
}

// ─── Principal helpers on FastifyRequest ────────────────────────────────────

function getCurrentPrincipalFastify(req: FastifyRequest): Principal | null {
  return req.principal ?? null;
}

function isLocalImplicitFastify(req: FastifyRequest): boolean {
  const p = req.principal;
  if (p?.type === "system") return true;
  return p?.type === "user" && p.id === LOCAL_BOARD_USER_ID;
}

// ─── Fastify error handler ────────────────────────────────────────────────────

function buildFastifyErrorHandler() {
  return (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) {
        logger.error({ err, method: req.method, url: req.url }, err.message);
      }
      void reply.status(err.status).send({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }

    if (err instanceof ZodError) {
      void reply.status(400).send({ error: "Validation error", details: err.issues });
      return;
    }

    const rootError = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: rootError, method: req.method, url: req.url }, "Internal server error");
    void reply.status(500).send({ error: "Internal server error" });
  };
}

// ─── Fastify 404 for /api/* ───────────────────────────────────────────────────

async function apiNotFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  void reply.status(404).send({ error: "API route not found" });
}

// ─── Main factory ─────────────────────────────────────────────────────────────

export async function createFastifyApp(db: Db, opts: CreateAppOpts): Promise<FastifyInstance> {
  initPlacementPrometheus(opts.metricsEnabled);

  // Fastify uses pino natively; we pass our configured logger instance.
  const fastify = Fastify({
    logger,
    disableRequestLogging: false,
    trustProxy: true,
  });

  // ── Decorate reply.locals ──────────────────────────────────────────────────
  // Fastify decorateReply initial value must match type; use getter/setter pattern.
  fastify.decorateReply("locals", {
    getter() {
      return (this as unknown as { _locals?: Record<string, unknown> })._locals ?? {};
    },
    setter(value: Record<string, unknown>) {
      (this as unknown as { _locals: Record<string, unknown> })._locals = value;
    },
  });
  fastify.addHook("onRequest", async (_req, reply) => {
    reply.locals = {};
  });

  // ── CSP nonce (before Helmet so it can use the nonce) ──────────────────────
  fastify.addHook("onRequest", async (_req, reply) => {
    attachNonce(reply);
  });

  // ── CORS ───────────────────────────────────────────────────────────────────
  const { corsAllowlist } = opts;
  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsAllowlist.length === 0) return cb(null, false);
      if (corsAllowlist.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  });

  // ── Helmet (CSP nonce-based for static/strict profiles) ───────────────────
  const viteHmrPort = opts.serverPort + 10000;
  const connectSrcExtras = opts.uiMode === "vite-dev"
    ? viteDevHmrConnectSrc(viteHmrPort, opts.bindHost)
    : [];

  // Disable Helmet's built-in CSP entirely; we set it ourselves in onSend so we
  // can embed the per-request nonce without a double-write race.
  await fastify.register(fastifyHelmet, { contentSecurityPolicy: false });

  if (opts.uiMode === "vite-dev") {
    fastify.addHook("onSend", async (_req, reply, payload) => {
      const cspValue = [
        `default-src 'self'`,
        `connect-src 'self' ${connectSrcExtras.join(" ")}`.trim(),
        `img-src 'self' data:`,
        `frame-ancestors 'none'`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
        `style-src 'self' 'unsafe-inline'`,
        `worker-src 'self' blob:`,
      ].join("; ");
      reply.header("Content-Security-Policy", cspValue);
      return payload;
    });
  } else {
    fastify.addHook("onSend", async (_req, reply, payload) => {
      const nonce = getNonce(reply);
      const styleSrc = opts.uiMode === "static"
        ? ["'self'", "'unsafe-inline'"]
        : [`'self'`, `'nonce-${nonce}'`];
      const cspValue = [
        `default-src 'self'`,
        `connect-src 'self' ${connectSrcExtras.join(" ")}`.trim(),
        `img-src 'self' data:`,
        `frame-ancestors 'none'`,
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src ${styleSrc.join(" ")}`,
      ].join("; ");
      reply.header("Content-Security-Policy", cspValue);
      return payload;
    });
  }

  // ── Permissions-Policy ────────────────────────────────────────────────────
  fastify.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    return payload;
  });

  // ── Body parsing ──────────────────────────────────────────────────────────
  // Fastify parses JSON by default; raw body content types (for GitHub webhook)
  // are handled per-route in Phase 3. Nothing extra needed globally.

  // ── Private hostname guard ────────────────────────────────────────────────
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  if (privateHostnameGateEnabled) {
    fastify.addHook("onRequest", async (req, reply) => {
      const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
      const hostHeader = (req.headers.host ?? "").trim();
      const raw = forwardedHost || hostHeader;

      let hostname: string | null = null;
      if (raw) {
        try {
          hostname = new URL(`http://${raw}`).hostname.trim().toLowerCase();
        } catch {
          hostname = raw.trim().toLowerCase();
        }
      }

      if (!hostname) {
        const error = "Missing Host header. If you want to allow a hostname, run pnpm hive allowed-hostname <host>.";
        void reply.status(403).send({ error });
        return;
      }

      const isApi = req.url.startsWith("/api");
      if (isLoopbackHostname(hostname) || privateHostnameAllowSet.has(hostname)) return;

      const error =
        `Hostname '${hostname}' is not allowed for this Hive instance. ` +
        `If you want to allow this hostname, please run pnpm hive allowed-hostname ${hostname}`;
      if (isApi) {
        void reply.status(403).send({ error });
      } else {
        void reply.status(403).type("text/plain").send(error);
      }
    });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const applyApiRateLimit =
    opts.deploymentMode !== "local_trusted" &&
    !(opts.deploymentMode === "authenticated" && isLoopbackBindHost(opts.bindHost));

  if (applyApiRateLimit) {
    const { rateLimitWindowMs, rateLimitMax } = opts;
    const sensitiveMax = Math.min(30, Math.max(10, Math.floor(rateLimitMax / 5)));

    // Sensitive routes: lower limit. Uses keyGenerator on URL to distinguish.
    const sensitivePrefixes = [
      "/api/auth/",
      "/api/instance/",
    ];
    const sensitivePatterns = [
      /^\/api\/companies\/[^/]+\/invites/,
      /^\/api\/agents\/[^/]+\/keys/,
      /^\/api\/agents\/[^/]+\/link-enrollment-tokens/,
      /^\/api\/companies\/[^/]+\/worker-instances\/[^/]+\/link-enrollment-tokens/,
      /^\/api\/companies\/[^/]+\/drone-provisioning-tokens/,
      /^\/api\/companies\/[^/]+\/worker-instances\/[^/]+\/agents\//,
      /^\/api\/companies\/[^/]+\/worker-instances\/[^/]+$/,
      /^\/api\/companies\/[^/]+\/worker-instances\/agents\//,
      /^\/api\/companies\/[^/]+\/agents\/[^/]+\/worker-pool\/rotate/,
      /^\/api\/worker-api\//,
      /^\/api\/worker-downloads\/provision-manifest/,
      /^\/api\/companies\/[^/]+\/worker-runtime\/manifest$/,
      /^\/api\/worker-pairing\//,
      /^\/api\/invites\/[^/]+\/accept/,
      /^\/api\/internal\/plugin-host\//,
    ];

    await fastify.register(fastifyRateLimit, {
      global: false, // per-route; we apply in an onRequest hook
    });

    fastify.addHook("onRequest", async (req, reply) => {
      const urlPath = req.url.split("?")[0] ?? "";
      if (!urlPath.startsWith("/api")) return;
      if (urlPath === "/api/health" || urlPath === "/api/health/") return;

      const isSensitive =
        sensitivePrefixes.some((p) => urlPath.startsWith(p)) ||
        sensitivePatterns.some((r) => r.test(urlPath));

      const max = isSensitive ? sensitiveMax : rateLimitMax;

      // Manual rate limit check using built-in store
      const key = `rl:${req.ip}:${isSensitive ? "s" : "g"}`;
      const store = (fastify as unknown as { rateLimitStore?: Map<string, { count: number; expiry: number }> }).rateLimitStore;
      if (store) {
        const now = Date.now();
        const entry = store.get(key);
        if (entry && entry.expiry > now) {
          if (entry.count >= max) {
            void reply.status(429).send({ error: "Too many requests" });
            return;
          }
          entry.count++;
        } else {
          store.set(key, { count: 1, expiry: now + rateLimitWindowMs });
        }
      }
    });

    // Attach an in-process store since we're managing it manually above
    (fastify as unknown as { rateLimitStore: Map<string, { count: number; expiry: number }> }).rateLimitStore = new Map();
  }

  // ── Principal resolution ──────────────────────────────────────────────────
  fastify.addHook("onRequest", async (req, _reply) => {
    try {
      // Adapt Fastify request to a minimal Express-compatible shape for the existing resolver
      const adaptedReq = req as unknown as Parameters<PrincipalResolver>[0];
      req.principal = await opts.principalResolver(adaptedReq);
    } catch {
      req.principal = null;
    }
  });

  // ── GET /api/auth/get-session ─────────────────────────────────────────────
  fastify.get("/api/auth/get-session", async (req, reply) => {
    const principal = getCurrentPrincipalFastify(req);
    const isBoard = principal?.type === "user" || principal?.type === "system";
    if (!isBoard || !principal?.id) {
      void reply.status(401).send({ error: "Unauthorized" });
      return;
    }
    const isLocalBoard = principal.id === LOCAL_BOARD_USER_ID || principal.type === "system";
    const payload: Record<string, unknown> = {
      session: {
        id: `hive:${principal.type}:${principal.id}`,
        userId: principal.id,
      },
      user: {
        id: principal.id,
        email: isLocalBoard ? "local@hive.local" : null,
        name: isLocalBoard ? "Local Board" : null,
      },
    };
    if (principal.type === "user" && principal.company_ids && principal.roles) {
      const accessToken = issueBoardJwt(
        principal.id,
        principal.company_ids,
        principal.roles.includes("instance_admin"),
      );
      if (accessToken) payload.accessToken = accessToken;
    }
    void reply.send(payload);
  });

  // ── Better Auth ───────────────────────────────────────────────────────────
  if (opts.betterAuthInstance) {
    const auth = opts.betterAuthInstance as { handler: (req: Request) => Promise<Response> };

    // Sign-up gate: block POST .../sign-up/email if disabled or users exist
    fastify.addHook("preHandler", async (req, reply) => {
      if (opts.deploymentMode !== "authenticated") return;
      if (!req.url.startsWith("/api/auth")) return;
      if (req.method.toUpperCase() !== "POST") return;
      const urlPath = req.url.split("?")[0] ?? "";
      if (!urlPath.includes("/sign-up/email")) return;

      const userCount = await db
        .select({ c: count() })
        .from(authUsers)
        .then((rows) => Number(rows[0]?.c ?? 0));
      const signUpDisabled = opts.authDisableSignUp || userCount > 0;
      if (signUpDisabled) {
        void reply.status(403).send({ message: "Sign up is disabled" });
      }
    });

    // All /api/auth/* routes handled by Better Auth
    fastify.all("/api/auth/*", async (req, reply) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const url = `${req.protocol}://${req.hostname}${req.url}`;
      const fetchReq = new Request(url, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD"
          ? JSON.stringify(req.body)
          : undefined,
      });

      const response = await auth.handler(fetchReq);
      void reply.status(response.status);

      for (const [key, value] of response.headers.entries()) {
        reply.header(key, value);
      }

      const body = await response.text();
      void reply.send(body);
    });
  }

  // ── Board mutation guard (on /api scope) ─────────────────────────────────
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    if (SAFE_METHODS.has(req.method.toUpperCase())) return;

    const p = getCurrentPrincipalFastify(req);
    const isBoard = p?.type === "user" || p?.type === "system";
    if (!isBoard) return;
    if (isLocalImplicitFastify(req)) return;

    if (!isTrustedBoardMutation(req)) {
      void reply.status(403).send({ error: "Board mutation requires trusted browser origin" });
    }
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  fastify.setErrorHandler(buildFastifyErrorHandler());

  // ── /api 404 catch-all ────────────────────────────────────────────────────
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api")) {
      return apiNotFoundHandler(req, reply);
    }
    void reply.status(404).send({ error: "Not found" });
  });

  // ── Express route adapter (Phase 3) ─────────────────────────────────────
  // Mount the existing Express routers via @fastify/middie until they are
  // progressively converted to Fastify plugins in subsequent phases.
  await fastify.register(fastifyMiddie);

  // Bridge req.principal from Fastify to the Express Request so existing
  // Express route handlers can read req.principal as expected.
  const expressApp = express();
  expressApp.use((req, _res, next) => {
    // The Fastify request has already resolved principal; copy it to the
    // Express-compatible req object that middie creates.
    (req as express.Request & { principal: Principal | null }).principal =
      (req as unknown as FastifyRequest).principal ?? null;
    next();
  });

  // GitHub webhook (raw body, before JSON parser)
  registerGithubWebhookBeforeJson(expressApp, db, {
    enabled: opts.vcsGitHubWebhookEnabled,
    secret: opts.vcsGitHubWebhookSecret,
    allowedRepos: opts.vcsGitHubAllowedRepos,
  });

  expressApp.use(express.json());

  // LLM routes (outside /api prefix in Express)
  expressApp.use(llmRoutes(db));

  // Main API routes
  const api = Router();
  registerMainApiRoutes(api, db, opts.storageService, {
    ...opts,
    betterAuthHandler: undefined,
    resolveSession: opts.resolveSession,
  } as unknown as Parameters<typeof import("./app.js").createApp>[1]);
  expressApp.use("/api", api);
  expressApp.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  fastify.use(expressApp);

  // ── Static / Vite dev UI (Phase 4) ────────────────────────────────────────
  const CSP_NONCE_PLACEHOLDER = "__CSP_NONCE__";
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  if (opts.uiMode === "static") {
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      const cachedIndexTemplate = applyUiBranding(
        fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"),
      );
      await fastify.register(fastifyStatic, { root: uiDist, wildcard: false });
      fastify.get("/*", async (req, reply) => {
        const nonce = getNonce(reply);
        const html = cachedIndexTemplate.replace(
          new RegExp(CSP_NONCE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          nonce,
        );
        return reply.status(200).type("text/html").send(html);
      });
    } else {
      console.warn("[hive] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: viteHmrPort,
          clientPort: viteHmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });

    let indexHtmlTransformChain: Promise<unknown> = Promise.resolve();
    const transformIndexHtmlWithCspNonce = async (url: string, html: string, cspNonce: string) => {
      const run = indexHtmlTransformChain.then(async () => {
        const root = vite.config as unknown as { html?: { cspNonce?: string } };
        if (!root.html) root.html = {};
        root.html.cspNonce = cspNonce;
        try {
          return await vite.transformIndexHtml(url, html);
        } finally {
          delete root.html.cspNonce;
        }
      });
      indexHtmlTransformChain = run.then(() => undefined, () => undefined);
      return run;
    };

    // Mount Vite's Connect middleware via middie
    fastify.use(vite.middlewares);

    // Catch-all: serve transformed index.html for SPA routes
    fastify.get("/*", async (req, reply) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const nonce = getNonce(reply);
        const withNonce = template.replace(
          new RegExp(CSP_NONCE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          nonce,
        );
        const html = ensureCspNonceOnScriptOpeningTags(
          applyUiBranding(await transformIndexHtmlWithCspNonce(req.url, withNonce, nonce) as string),
          nonce,
        );
        return reply.status(200).type("text/html").send(html);
      } catch (err) {
        throw err;
      }
    });
  }

  startPluginSupervisorRuntime();

  return fastify;
}
