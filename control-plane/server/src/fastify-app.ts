/// <reference path="./types/fastify.d.ts" />
/**
 * Fastify application factory — sole HTTP entry point for the control plane.
 *
 * Architecture:
 *   Core hooks  (CORS, CSP, Helmet, hostname guard, rate-limit, principal)
 *   Auth layer  (Better Auth + sign-up gate)
 *   Domain routes (Fastify plugins)
 *   UI layer    (@fastify/static or Vite dev middleware)
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
import { initPlacementPrometheus, renderPlacementPrometheusScrape } from "./placement-metrics.js";
import { resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { applyUiBranding } from "./ui-branding.js";
import { ensureCspNonceOnScriptOpeningTags } from "./middleware/csp-nonce.js";
import { startPluginSupervisorRuntime } from "./services/plugin-supervisor.js";
import type { FastifyPrincipalResolver } from "./middleware/auth.js";
import { githubWebhookPlugin } from "./routes/integrations-github.js";
import { llmPlugin } from "./routes/llms.js";
import { companyEventsSSEPlugin } from "./routes/events-sse.js";
import { healthPlugin } from "./routes/health.js";
import { releasesPlugin } from "./routes/releases.js";
import { workerDownloadsPlugin } from "./routes/worker-downloads.js";
import { workerApiPlugin } from "./routes/worker-api/index.js";
import {
  internalHiveTrainingCallbackPlugin,
  internalHiveOperatorPlugin,
} from "./routes/internal-hive.js";
import { pluginHostPlugin } from "./routes/plugin-host.js";
import { e2eMcpSmokePlugin } from "./routes/e2e-mcp-smoke.js";
import { assetsPlugin } from "./routes/assets.js";
import { issueAttachmentsPlugin } from "./routes/issue-routes/issue-attachments-routes.js";
import { companiesPlugin } from "./routes/companies/index.js";
import { agentsPlugin } from "./routes/agents/index.js";
import { issuesPlugin } from "./routes/issue-routes/index.js";
import { accessPlugin } from "./routes/access.js";
import { workloadPlugin } from "./routes/workload.js";
import { standupPlugin } from "./routes/standup.js";
import { dashboardPlugin } from "./routes/dashboard.js";
import { sidebarBadgesPlugin } from "./routes/sidebar-badges.js";
import { goalsPlugin } from "./routes/goals.js";
import { activityPlugin } from "./routes/activity.js";
import { pluginBoardPlugin } from "./routes/plugins.js";
import { webhookDeliveriesPlugin } from "./routes/webhook-deliveries.js";
import { connectPlugin } from "./routes/connect.js";
import { instancePlugin } from "./routes/instance.js";
import { costsPlugin } from "./routes/costs.js";
import { secretsPlugin } from "./routes/secrets.js";
import { projectsPlugin } from "./routes/projects.js";
import { departmentsPlugin } from "./routes/departments.js";
import { approvalsPlugin } from "./routes/approvals.js";
import { instanceStatusPlugin } from "./routes/instance-status.js";
import { workerPairingPublicPlugin } from "./routes/worker-pairing-public.js";

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
   * The raw Better Auth instance, not an Express RequestHandler.
   * Passed through from bootstrap/auth.ts via betterAuthInstance.
   */
  betterAuthInstance?: unknown;
  /**
   * Fetch-style session resolver — used by Fastify-native auth hooks and
   * the Better Auth request bridge.
   */
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  /**
   * Fastify-native principal resolver.
   */
  principalResolver: FastifyPrincipalResolver;
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

    // @fastify/rate-limit throws Error instances with a numeric statusCode.
    // Handle them here so they propagate with the correct HTTP status.
    const httpErr = err as { statusCode?: number; message?: string; retryAfter?: string };
    if (typeof httpErr?.statusCode === "number" && httpErr.statusCode < 500) {
      const body: Record<string, unknown> = { error: httpErr.message ?? "Request failed" };
      if (httpErr.retryAfter) body.retryAfter = httpErr.retryAfter;
      void reply.status(httpErr.statusCode).send(body);
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
  // Limits are only applied in authenticated (non-loopback) and public modes.
  // local_trusted and loopback-authenticated deployments are exempt to avoid
  // disrupting rapid developer iteration.
  //
  // Two tiers are enforced on the /api prefix:
  //   - General: rateLimitMax per window (e.g. 300 req/min)
  //   - Sensitive: sensitiveMax per window (≤30, default 1/5 of general)
  //
  // The sensitive tier covers auth, provisioning, enrollment, and key routes.
  // NOTE: For multi-replica deployments, configure a Redis store via
  // HIVE_RATE_LIMIT_STORE_URL so limits are shared across replicas.
  const applyApiRateLimit =
    opts.deploymentMode !== "local_trusted" &&
    !(opts.deploymentMode === "authenticated" && isLoopbackBindHost(opts.bindHost));

  if (applyApiRateLimit) {
    const { rateLimitWindowMs, rateLimitMax } = opts;
    const sensitiveMax = Math.min(30, Math.max(10, Math.floor(rateLimitMax / 5)));

    // Patterns that identify sensitive paths subject to the lower rate limit.
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

    function isSensitivePath(urlPath: string): boolean {
      return (
        sensitivePrefixes.some((p) => urlPath.startsWith(p)) ||
        sensitivePatterns.some((r) => r.test(urlPath))
      );
    }

    // Register @fastify/rate-limit in global mode with a keyGenerator that
    // produces a compound key of (ip, tier) so each tier has its own bucket.
    // Health and non-/api paths are excluded via allowList so they are never
    // counted.  The max limit per bucket is resolved per-request.
    await fastify.register(fastifyRateLimit, {
      global: true,
      timeWindow: rateLimitWindowMs,
      max: (req) => {
        const urlPath = (req.url ?? "").split("?")[0] ?? "";
        return isSensitivePath(urlPath) ? sensitiveMax : rateLimitMax;
      },
      allowList: (req) => {
        const urlPath = (req.url ?? "").split("?")[0] ?? "";
        return !urlPath.startsWith("/api") || urlPath === "/api/health" || urlPath === "/api/health/";
      },
      keyGenerator: (req) => {
        const urlPath = (req.url ?? "").split("?")[0] ?? "";
        const tier = isSensitivePath(urlPath) ? "s" : "g";
        return `rl:${req.ip ?? "unknown"}:${tier}`;
      },
      // The builder must return an Error (not a plain object) so Fastify's
      // error handler receives it with err.statusCode set to 429.
      errorResponseBuilder: (_req, context) => {
        const err = new Error(`Too many requests`) as Error & { statusCode: number; retryAfter: string };
        err.statusCode = context.statusCode;
        err.retryAfter = context.after;
        return err;
      },
    });
  }

  // ── Principal resolution ──────────────────────────────────────────────────
  fastify.addHook("onRequest", async (req, _reply) => {
    try {
      req.principal = await opts.principalResolver(req);
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

    // All /api/auth/* routes handled by Better Auth.
    // We construct a standards-compliant Fetch Request from the raw Node
    // IncomingMessage so Better Auth receives the original body bytes
    // regardless of content-type (JSON, form, multipart).
    fastify.all("/api/auth/*", { config: { rawBody: true } }, async (req, reply) => {
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

      // Forward the request body to Better Auth preserving the original bytes.
      // Better Auth handles its own content-type parsing (JSON, form-urlencoded,
      // multipart) so we must not re-serialise an already-parsed req.body.
      let bodyStr: string | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        // rawBody is a Buffer populated by Fastify's addContentTypeParser for
        // routes with config.rawBody = true.  If available, decode to string
        // so the original encoding (UTF-8) is preserved end-to-end.
        const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
        if (raw && raw.length > 0) {
          bodyStr = raw.toString("utf8");
        } else if (req.body !== undefined && req.body !== null) {
          const ct = (req.headers["content-type"] ?? "").toLowerCase();
          if (ct.startsWith("application/json")) {
            bodyStr = JSON.stringify(req.body);
          }
        }
      }

      const fetchReq = new Request(url, {
        method: req.method,
        headers,
        body: bodyStr,
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

  // ── Fastify-native domain plugins ────────────────────────────────────────
  // Each migrated route batch is registered here, above the Express bridge.
  // These routes are handled by Fastify directly and never fall through to
  // the Express sub-app.

  // PR 2: Infrastructure routes (health, releases, worker-downloads, metrics)
  await fastify.register(healthPlugin, {
    db,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    authReady: opts.authReady,
    companyDeletionEnabled: opts.companyDeletionEnabled,
    authDisableSignUp: opts.authDisableSignUp,
  });

  await fastify.register(releasesPlugin);

  await fastify.register(workerDownloadsPlugin, {
    authPublicBaseUrl: opts.authPublicBaseUrl,
    workerProvisionManifestJson: opts.workerProvisionManifestJson,
    workerProvisionManifestFile: opts.workerProvisionManifestFile,
    workerProvisionManifestSigningKeyPem: opts.workerProvisionManifestSigningKeyPem,
  });

  if (opts.metricsEnabled) {
    fastify.get("/api/metrics", async (_req, reply) => {
      const out = await renderPlacementPrometheusScrape();
      if (!out) {
        return reply.status(503).send({ error: "Metrics unavailable" });
      }
      return reply.status(200).header("Content-Type", out.contentType).send(out.body);
    });
  }

  // PR 3: GitHub webhook (Fastify-native, route-scoped raw-body parser)
  await fastify.register(githubWebhookPlugin, {
    enabled: opts.vcsGitHubWebhookEnabled,
    secret: opts.vcsGitHubWebhookSecret,
    allowedRepos: opts.vcsGitHubAllowedRepos,
    db,
  });

  // PR 3: LLM agent-configuration reflection routes
  await fastify.register(llmPlugin, { db });

  // PR 3: Company events SSE
  await fastify.register(companyEventsSSEPlugin, {
    db,
    deploymentMode: opts.deploymentMode,
    resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
  });

  // PR 4: Worker API (drone JWT bearer auth, idempotency preserved)
  await fastify.register(
    async (instance) => {
      await workerApiPlugin(instance, { db, secretsStrictMode: opts.secretsStrictMode });
    },
    { prefix: "/api/worker-api" },
  );

  // PR 4: Internal Hive routes (training callbacks, operator endpoints)
  await fastify.register(internalHiveTrainingCallbackPlugin, {
    db,
    internalOperatorSecret: opts.internalHiveOperatorSecret,
  });
  if (opts.internalHiveOperatorSecret?.trim()) {
    await fastify.register(internalHiveOperatorPlugin, {
      db,
      operatorSecret: opts.internalHiveOperatorSecret.trim(),
    });
  }

  // PR 4: Plugin host RPC
  if (opts.pluginHostSecret?.trim()) {
    await fastify.register(pluginHostPlugin, {
      db,
      hostSecret: opts.pluginHostSecret.trim(),
    });
  }

  // PR 4: E2E MCP smoke (local_trusted only)
  if (opts.deploymentMode === "local_trusted" && opts.e2eMcpSmokeMaterializeSecret?.trim()) {
    await fastify.register(e2eMcpSmokePlugin, {
      db,
      materializeSecret: opts.e2eMcpSmokeMaterializeSecret.trim(),
      serverPort: opts.serverPort,
    });
  }

  // ── PR 5: File upload routes (assets + issue attachments) ─────────────────
  // NOTE: /api/companies/:companyId/assets migrated in PR 5.
  // NOTE: /api/issues/:id/attachments and /api/attachments/:attachmentId migrated in PR 5.
  await fastify.register(assetsPlugin, { db, storage: opts.storageService });
  await fastify.register(issueAttachmentsPlugin, { db, storage: opts.storageService });

  // PR 4: Worker pairing public (unauthenticated: drone POST/GET /api/worker-pairing/requests)
  await fastify.register(workerPairingPublicPlugin, { db });

  // ── PR 7: Complex domain route plugins ───────────────────────────────────
  await fastify.register(agentsPlugin, { db, strictSecretsMode: opts.secretsStrictMode });
  await fastify.register(issuesPlugin, { db, storage: opts.storageService });
  await fastify.register(accessPlugin, {
    db,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames,
    joinAllowedAdapterTypes: opts.joinAllowedAdapterTypes,
  });
  await fastify.register(companiesPlugin, {
    db,
    drainAutoEvacuateEnabled: opts.drainAutoEvacuateEnabled,
    drainCancelInFlightPlacementsEnabled: opts.drainCancelInFlightPlacementsEnabled,
    workerIdentityAutomationEnabled: opts.workerIdentityAutomationEnabled ?? true,
    apiPublicBaseUrl: opts.apiPublicBaseUrl,
    workerProvisionManifestJson: opts.workerProvisionManifestJson,
    workerProvisionManifestFile: opts.workerProvisionManifestFile,
    workerProvisionManifestSigningKeyPem: opts.workerProvisionManifestSigningKeyPem,
    bifrostAdmin:
      opts.bifrostAdminBaseUrl?.trim() && opts.bifrostAdminToken?.trim()
        ? { baseUrl: opts.bifrostAdminBaseUrl.trim(), token: opts.bifrostAdminToken.trim() }
        : undefined,
    internalHiveOperatorSecret: opts.internalHiveOperatorSecret,
  });

  // ── PR 6: Domain route plugins (simple + medium complexity) ──────────────
  await fastify.register(workloadPlugin, { db });
  await fastify.register(standupPlugin, { db });
  await fastify.register(dashboardPlugin, { db });
  await fastify.register(sidebarBadgesPlugin, { db });
  await fastify.register(goalsPlugin, { db });
  await fastify.register(activityPlugin, { db });
  await fastify.register(pluginBoardPlugin, { db });
  await fastify.register(webhookDeliveriesPlugin, { db });
  await fastify.register(connectPlugin, { db, authPublicBaseUrl: opts.authPublicBaseUrl });
  await fastify.register(instancePlugin, { db, deploymentMode: opts.deploymentMode });
  await fastify.register(costsPlugin, { db });
  await fastify.register(secretsPlugin, { db, defaultProvider: opts.secretsProvider });
  await fastify.register(projectsPlugin, { db });
  await fastify.register(departmentsPlugin, { db });
  await fastify.register(approvalsPlugin, { db, strictSecretsMode: opts.secretsStrictMode });
  await fastify.register(instanceStatusPlugin, {
    db,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    authReady: opts.authReady,
    companyDeletionEnabled: opts.companyDeletionEnabled,
    authDisableSignUp: opts.authDisableSignUp,
    activeDatabaseConnectionString: opts.activeDatabaseConnectionString,
    metricsEnabled: opts.metricsEnabled,
    workload: (await import("./services/workload.js")).workloadService(db),
  });

  // ── middie (needed for Vite dev middleware) ──────────────────────────────
  await fastify.register(fastifyMiddie);

  // ── Static / Vite dev UI ──────────────────────────────────────────────────
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

/**
 * Alias so index.ts can import createApp without knowing the underlying
 * framework — this is the Fastify implementation.
 */
export const createApp = createFastifyApp;
