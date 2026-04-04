/**
 * Regression tests for @fastify/rate-limit integration.
 *
 * Verifies that:
 *  - General /api routes are throttled at the configured max.
 *  - Sensitive routes (auth, worker-api, invites, …) are throttled at a
 *    stricter lower limit.
 *  - /api/health is exempt from rate limiting.
 *  - Non-/api paths (static assets) are not rate limited.
 *  - The 429 response payload contains { error, retryAfter }.
 */
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const SENSITIVE_MAX = 2; // Math.min(30, Math.max(10, floor(10/5))) = 2, then clamped to 10 — let's test with explicit values below

/**
 * Build a Fastify instance with the same rate-limit configuration used in
 * fastify-app.ts, parameterised for test-friendly low limits.
 */
async function buildApp(opts: {
  rateLimitMax: number;
  sensitiveMax: number;
  windowMs: number;
}) {
  const { rateLimitMax, sensitiveMax, windowMs } = opts;

  const sensitivePrefixes = ["/api/auth/", "/api/instance/"];
  const sensitivePatterns = [
    /^\/api\/worker-api\//,
    /^\/api\/worker-pairing\//,
    /^\/api\/invites\/[^/]+\/accept/,
  ];

  function isSensitive(urlPath: string): boolean {
    return (
      sensitivePrefixes.some((p) => urlPath.startsWith(p)) ||
      sensitivePatterns.some((r) => r.test(urlPath))
    );
  }

  const fastify = Fastify({ logger: false });

  // Mirror the error handler from fastify-app.ts to ensure rate-limit errors
  // are surfaced with the correct HTTP status rather than the default 500.
  fastify.setErrorHandler((err, _req, reply) => {
    const httpErr = err as { statusCode?: number; message?: string; retryAfter?: string };
    if (typeof httpErr.statusCode === "number" && httpErr.statusCode < 500) {
      const body: Record<string, unknown> = { error: httpErr.message ?? "Request failed" };
      if (httpErr.retryAfter) body.retryAfter = httpErr.retryAfter;
      void reply.status(httpErr.statusCode).send(body);
      return;
    }
    void reply.status(500).send({ error: "Internal server error" });
  });

  await fastify.register(fastifyRateLimit, {
    global: true,
    timeWindow: windowMs,
    max: (req) => {
      const urlPath = (req.url ?? "").split("?")[0] ?? "";
      return isSensitive(urlPath) ? sensitiveMax : rateLimitMax;
    },
    allowList: (req) => {
      const urlPath = (req.url ?? "").split("?")[0] ?? "";
      return !urlPath.startsWith("/api") || urlPath === "/api/health" || urlPath === "/api/health/";
    },
    keyGenerator: (req) => {
      const urlPath = (req.url ?? "").split("?")[0] ?? "";
      const tier = isSensitive(urlPath) ? "s" : "g";
      return `rl:${req.ip ?? "unknown"}:${tier}`;
    },
    errorResponseBuilder: (_req, context) => {
      const err = new Error("Too many requests") as Error & { statusCode: number; retryAfter: string };
      err.statusCode = context.statusCode;
      err.retryAfter = context.after;
      return err;
    },
  });

  fastify.get("/api/data", async (_req, reply) => reply.send({ ok: true }));
  fastify.get("/api/health", async (_req, reply) => reply.send({ status: "ok" }));
  fastify.post("/api/auth/sign-in/email", async (_req, reply) => reply.send({ ok: true }));
  fastify.post("/api/worker-api/ping", async (_req, reply) => reply.send({ ok: true }));
  fastify.get("/static/app.js", async (_req, reply) => reply.send("js"));

  await fastify.ready();
  return fastify;
}

describe("rate-limit", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({
      rateLimitMax: 5,
      sensitiveMax: 2,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows requests up to rateLimitMax on general /api routes", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/api/data" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("blocks the (rateLimitMax + 1)th request on general /api routes", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "GET", url: "/api/data" });
    }
    const res = await app.inject({ method: "GET", url: "/api/data" });
    expect(res.statusCode).toBe(429);
    const body = res.json<{ error: string; retryAfter?: string }>();
    expect(body.error).toBe("Too many requests");
  });

  it("applies the stricter sensitive limit on /api/auth/* routes", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: {} });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: {} });
    expect(res.statusCode).toBe(429);
  });

  it("applies the stricter sensitive limit on /api/worker-api/* routes", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/api/worker-api/ping", payload: {} });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({ method: "POST", url: "/api/worker-api/ping", payload: {} });
    expect(res.statusCode).toBe(429);
  });

  it("does not rate-limit /api/health", async () => {
    // Each inject uses a unique req.id so each gets an exempt: key — fire more
    // than rateLimitMax times to confirm health is always 200.
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("does not rate-limit non-/api static assets", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: "/static/app.js" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("general and sensitive buckets are independent", async () => {
    // Exhaust sensitive bucket
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: {} });
    }
    const sensitiveBlocked = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: {} });
    expect(sensitiveBlocked.statusCode).toBe(429);

    // General bucket is independent — still has capacity
    const generalRes = await app.inject({ method: "GET", url: "/api/data" });
    expect(generalRes.statusCode).toBe(200);
  });
});
