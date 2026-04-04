import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import { randomBytes } from "node:crypto";

async function buildFastifySecurityApp(opts: {
  cspProfile?: "strict" | "vite-dev" | "static-ui";
  connectSrcExtras?: string[];
}): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });

  // CSP nonce per request
  f.decorateReply("locals", {
    getter() { return (this as unknown as { _locals?: Record<string, unknown> })._locals ?? {}; },
    setter(v: Record<string, unknown>) { (this as unknown as { _locals: Record<string, unknown> })._locals = v; },
  });
  f.addHook("onRequest", async (_req, reply) => {
    (reply as unknown as { locals: Record<string, unknown> }).locals = {
      cspNonce: randomBytes(32).toString("hex"),
    };
  });

  const profile = opts.cspProfile ?? "strict";
  const extras = opts.connectSrcExtras ?? [];

  // Always disable Helmet's CSP; we set it ourselves in onSend so we can embed the per-request nonce.
  await f.register(fastifyHelmet, { contentSecurityPolicy: false });

  if (profile === "vite-dev") {
    f.addHook("onSend", async (_req, reply, payload) => {
      const cspValue = [
        `default-src 'self'`,
        `connect-src 'self' ${extras.join(" ")}`.trim(),
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
    f.addHook("onSend", async (_req, reply, payload) => {
      const nonce = ((reply as unknown as { locals: Record<string, unknown> }).locals?.cspNonce as string) ?? "";
      const styleSrc = profile === "static-ui"
        ? ["'self'", "'unsafe-inline'"]
        : [`'self'`, `'nonce-${nonce}'`];
      const cspValue = [
        `default-src 'self'`,
        `connect-src 'self' ${extras.join(" ")}`.trim(),
        `img-src 'self' data:`,
        `frame-ancestors 'none'`,
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src ${styleSrc.join(" ")}`,
      ].join("; ");
      reply.header("Content-Security-Policy", cspValue);
      return payload;
    });
  }

  // Permissions-Policy
  f.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    return payload;
  });

  f.get("/ping", async (_req, reply) => reply.send({ ok: true }));
  await f.ready();
  return f;
}

describe("security headers (Helmet + nonce) — Fastify", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildFastifySecurityApp({}); });
  afterAll(async () => { await app.close(); });

  it("sets X-Content-Type-Options on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(["DENY", "SAMEORIGIN"]).toContain(res.headers["x-frame-options"]);
  });

  it("sets Referrer-Policy on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.headers["referrer-policy"]).toBeDefined();
  });

  it("sets Permissions-Policy on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.headers["permissions-policy"]).toContain("geolocation=()");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("sets Content-Security-Policy with nonce on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp as string).toMatch(/'nonce-[0-9a-f]{64}'/);
  });

  it("includes connect-src extras", async () => {
    const app2 = await buildFastifySecurityApp({ connectSrcExtras: ["ws://127.0.0.1:13100"] });
    const res = await app2.inject({ method: "GET", url: "/ping" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("connect-src");
    expect(csp).toContain("ws://127.0.0.1:13100");
    await app2.close();
  });

  it("vite-dev CSP relaxes script and style for tooling (Vite, MDXEditor)", async () => {
    const app2 = await buildFastifySecurityApp({ cspProfile: "vite-dev" });
    const res = await app2.inject({ method: "GET", url: "/ping" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("script-src");
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    expect(csp).toMatch(/worker-src[^;]*blob:/);
    await app2.close();
  });

  it("static-ui CSP keeps script nonce and relaxes style-src", async () => {
    const app2 = await buildFastifySecurityApp({ cspProfile: "static-ui" });
    const res = await app2.inject({ method: "GET", url: "/ping" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/'nonce-[0-9a-f]{64}'/);
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    await app2.close();
  });
});
