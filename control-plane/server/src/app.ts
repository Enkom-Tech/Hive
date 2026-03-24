import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Db } from "@hive/db";
import type { DeploymentExposure, DeploymentMode } from "@hive/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { cspNonceMiddleware, ensureCspNonceOnScriptOpeningTags } from "./middleware/csp-nonce.js";
import { createHelmet, permissionsPolicyMiddleware } from "./middleware/helmet-config.js";
import { createPrincipalMiddleware } from "./middleware/auth.js";
import { issueBoardJwt } from "./auth/board-jwt.js";
import { getCurrentPrincipal } from "./auth/principal.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { createAuthenticatedSignUpGateMiddleware } from "./middleware/sign-up-gate.js";
import { healthRoutes } from "./routes/health.js";
import { instanceRoutes } from "./routes/instance.js";
import { instanceStatusRoutes } from "./routes/instance-status.js";
import { workloadService } from "./services/workload.js";
import { companyRoutes } from "./routes/companies.js";
import { agentRoutes } from "./routes/agents/index.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { standupRoutes } from "./routes/standup.js";
import { workloadRoutes } from "./routes/workload.js";
import { webhookDeliveryRoutes } from "./routes/webhook-deliveries.js";
import { connectRoutes } from "./routes/connect.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { departmentRoutes } from "./routes/departments.js";
import { createCompanyEventsSSEHandler } from "./routes/events-sse.js";
import { releaseRoutes } from "./routes/releases.js";
import { workerDownloadsRoutes } from "./routes/worker-downloads.js";
import { workerToolRoutes } from "./routes/worker-tools.js";
import { applyUiBranding } from "./ui-branding.js";
import { initPlacementPrometheus, renderPlacementPrometheusScrape } from "./placement-metrics.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";

function isLoopbackBindHost(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "[::1]";
}

/** CSP connect-src entries for Vite middleware HMR (separate ws/http port). */
function viteDevHmrConnectSrc(hmrPort: number, bindHost: string): string[] {
  const hosts = new Set<string>(["127.0.0.1", "localhost"]);
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") {
    hosts.add(bindHost);
  }
  const urls: string[] = [];
  for (const host of hosts) {
    urls.push(`ws://${host}:${hmrPort}`, `http://${host}:${hmrPort}`);
  }
  return urls;
}

export async function createApp(
  db: Db,
  opts: {
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
    /** ADR 005 Phase C: auto-evacuate automatic bindings when a drone is marked draining. */
    drainAutoEvacuateEnabled: boolean;
    workerIdentityAutomationEnabled?: boolean;
    /** Preferred public API origin for generated drone automation profiles (optional; routes may fall back to request Host). */
    apiPublicBaseUrl?: string;
    workerProvisionManifestJson?: string;
    workerProvisionManifestFile?: string;
    workerProvisionManifestSigningKeyPem?: string;
    workerToolBridgeAllowedActions?: string[];
    authPublicBaseUrl?: string;
    /** Disables self-service sign-up (Better Auth + gate); authenticated mode only. */
    authDisableSignUp: boolean;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    principalResolver: import("./middleware/auth.js").PrincipalResolver;
    /** Active Postgres URL for migration inspect/apply (never exposed to clients). */
    activeDatabaseConnectionString?: string;
  },
) {
  const app = express();

  initPlacementPrometheus(opts.metricsEnabled);

  const viteHmrPort = opts.serverPort + 10000;
  const helmetConnectSrcExtras =
    opts.uiMode === "vite-dev" ? viteDevHmrConnectSrc(viteHmrPort, opts.bindHost) : [];

  const { corsAllowlist, rateLimitWindowMs, rateLimitMax } = opts;
  app.use(
    cors({
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) return cb(null, true);
        if (corsAllowlist.length === 0) return cb(null, false);
        if (corsAllowlist.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );

  app.use(cspNonceMiddleware);
  app.use(
    createHelmet({
      connectSrcExtras: helmetConnectSrcExtras,
      cspProfile:
        opts.uiMode === "vite-dev" ? "vite-dev" : opts.uiMode === "static" ? "static-ui" : "strict",
    }),
  );
  app.use(permissionsPolicyMiddleware);
  app.use(express.json());
  app.use(httpLogger);

  const apiLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  });
  const sensitiveLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: Math.min(30, Math.max(10, Math.floor(rateLimitMax / 5))),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  });
  // local_trusted: no limits. Authenticated on loopback bind: same UI polling as local dev — skip limits.
  // Authenticated on a non-loopback bind: enforce limits (see HIVE_RATE_LIMIT_*).
  const applyApiRateLimit =
    opts.deploymentMode !== "local_trusted" &&
    !(opts.deploymentMode === "authenticated" && isLoopbackBindHost(opts.bindHost));
  app.use("/api", (req, res, next) => {
    if (!applyApiRateLimit) return next();
    // UI polls /api/health every few seconds while bootstrap is pending; counting it against the global
    // budget causes 429 and a misleading "control plane unavailable" state.
    const pathname = req.originalUrl.split("?")[0] ?? "";
    if (pathname === "/api/health" || pathname === "/api/health/") return next();
    const path = req.path;
    const isSensitive =
      path.startsWith("/auth/") ||
      path.startsWith("/instance/") ||
      /^\/companies\/[^/]+\/invites/.test(path) ||
      /^\/agents\/[^/]+\/keys/.test(path) ||
      /^\/agents\/[^/]+\/link-enrollment-tokens/.test(path) ||
      /^\/companies\/[^/]+\/worker-instances\/[^/]+\/link-enrollment-tokens/.test(path) ||
      /^\/companies\/[^/]+\/drone-provisioning-tokens/.test(path) ||
      /^\/companies\/[^/]+\/worker-instances\/[^/]+\/agents\//.test(path) ||
      /^\/companies\/[^/]+\/worker-instances\/[^/]+$/.test(path) ||
      /^\/companies\/[^/]+\/worker-instances\/agents\//.test(path) ||
      /^\/companies\/[^/]+\/agents\/[^/]+\/worker-pool\/rotate/.test(path) ||
      /^\/worker-tools\/bridge/.test(path) ||
      /^\/worker-downloads\/provision-manifest/.test(path) ||
      /^\/companies\/[^/]+\/worker-runtime\/manifest$/.test(path) ||
      /^\/worker-pairing\//.test(path) ||
      /^\/invites\/[^/]+\/accept/.test(path);
    if (isSensitive) return sensitiveLimiter(req, res, next);
    return apiLimiter(req, res, next);
  });
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(createPrincipalMiddleware(opts.principalResolver));
  app.get("/api/auth/get-session", (req, res) => {
    const principal = getCurrentPrincipal(req);
    const isBoard = principal?.type === "user" || principal?.type === "system";
    if (!isBoard || !principal?.id) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const payload: Record<string, unknown> = {
      session: {
        id: `hive:${principal.type}:${principal.id}`,
        userId: principal.id,
      },
      user: {
        id: principal.id,
        email: null,
        name: principal.type === "system" ? "Local Board" : null,
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
    res.json(payload);
  });
  if (opts.betterAuthHandler) {
    app.use(
      "/api/auth",
      createAuthenticatedSignUpGateMiddleware(db, {
        deploymentMode: opts.deploymentMode,
        authDisableSignUp: opts.authDisableSignUp,
      }),
    );
    app.all("/api/auth/*authPath", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      authDisableSignUp: opts.authDisableSignUp,
    }),
  );
  if (opts.metricsEnabled) {
    api.get("/metrics", async (_req, res) => {
      const out = await renderPlacementPrometheusScrape();
      if (!out) {
        res.status(503).json({ error: "Metrics unavailable" });
        return;
      }
      res.status(200).set("Content-Type", out.contentType).send(out.body);
    });
  }
  api.use("/releases", releaseRoutes());
  api.use(
    "/worker-downloads",
    workerDownloadsRoutes({
      authPublicBaseUrl: opts.authPublicBaseUrl,
      workerProvisionManifestJson: opts.workerProvisionManifestJson,
      workerProvisionManifestFile: opts.workerProvisionManifestFile,
      workerProvisionManifestSigningKeyPem: opts.workerProvisionManifestSigningKeyPem,
    }),
  );
  api.use(
    "/worker-tools",
    workerToolRoutes(db, { allowedActions: opts.workerToolBridgeAllowedActions ?? [] }),
  );
  api.get(
    "/companies/:companyId/events",
    createCompanyEventsSSEHandler(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  api.use(
    "/companies",
    companyRoutes(db, {
      drainAutoEvacuateEnabled: opts.drainAutoEvacuateEnabled,
      workerIdentityAutomationEnabled: opts.workerIdentityAutomationEnabled ?? true,
      apiPublicBaseUrl: opts.apiPublicBaseUrl,
      workerProvisionManifestJson: opts.workerProvisionManifestJson,
      workerProvisionManifestFile: opts.workerProvisionManifestFile,
      workerProvisionManifestSigningKeyPem: opts.workerProvisionManifestSigningKeyPem,
    }),
  );
  api.use(agentRoutes(db, { strictSecretsMode: opts.secretsStrictMode }));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db, opts.secretsStrictMode));
  api.use(secretRoutes(db, opts.secretsProvider));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(standupRoutes(db));
  api.use(workloadRoutes(db));
  api.use(webhookDeliveryRoutes(db));
  api.use(connectRoutes(db, { authPublicBaseUrl: opts.authPublicBaseUrl }));
  api.use(sidebarBadgeRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
      joinAllowedAdapterTypes: opts.joinAllowedAdapterTypes,
    }),
  );
  api.use(departmentRoutes(db));
  api.use("/instance", instanceRoutes(db, { deploymentMode: opts.deploymentMode }));
  api.use(
    "/instance",
    instanceStatusRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      authDisableSignUp: opts.authDisableSignUp,
      activeDatabaseConnectionString: opts.activeDatabaseConnectionString,
      metricsEnabled: opts.metricsEnabled,
      workload: workloadService(db),
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  const CSP_NONCE_PLACEHOLDER = "__CSP_NONCE__";
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      const cachedIndexTemplate = applyUiBranding(
        fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"),
      );
      app.use(express.static(uiDist));
      app.get(/.*/, (_req, res) => {
        const html = cachedIndexTemplate.replace(
          new RegExp(CSP_NONCE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          res.locals.cspNonce ?? "",
        );
        res.status(200).set("Content-Type", "text/html").end(html);
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
      // "custom" disables Vite's htmlFallback + indexHtml middleware. With "spa", those run before
      // this Express app and serve index.html from disk (skipping CSP nonce replace + our HTML pass).
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

    /** Vite uses `config.html.cspNonce` so injectNonceAttributeTagHook can add `nonce` to injected inline scripts (React refresh preamble). Serialize: resolved config is shared across concurrent requests. */
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
      indexHtmlTransformChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const withNonce = template.replace(
          new RegExp(CSP_NONCE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          res.locals.cspNonce ?? "",
        );
        const nonce = res.locals.cspNonce ?? "";
        const html = ensureCspNonceOnScriptOpeningTags(
          applyUiBranding(await transformIndexHtmlWithCspNonce(req.originalUrl, withNonce, nonce)),
          nonce,
        );
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  return app;
}
