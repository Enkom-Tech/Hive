import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { cspNonceMiddleware } from "../middleware/csp-nonce.js";
import { createHelmet, permissionsPolicyMiddleware } from "../middleware/helmet-config.js";

describe("security headers (Helmet + nonce)", () => {
  const app = express();
  app.use(cspNonceMiddleware);
  app.use(createHelmet());
  app.use(permissionsPolicyMiddleware);
  app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));

  it("sets X-Content-Type-Options on responses", async () => {
    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options on responses", async () => {
    const res = await request(app).get("/ping");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(["DENY", "SAMEORIGIN"]).toContain(res.headers["x-frame-options"]);
  });

  it("sets Referrer-Policy on responses", async () => {
    const res = await request(app).get("/ping");
    expect(res.headers["referrer-policy"]).toBeDefined();
  });

  it("sets Permissions-Policy on responses", async () => {
    const res = await request(app).get("/ping");
    expect(res.headers["permissions-policy"]).toContain("geolocation=()");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("sets Content-Security-Policy with nonce on responses", async () => {
    const res = await request(app).get("/ping");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/'nonce-[0-9a-f]{64}'/);
  });

  it("includes connect-src extras when passed to createHelmet", async () => {
    const app2 = express();
    app2.use(cspNonceMiddleware);
    app2.use(createHelmet({ connectSrcExtras: ["ws://127.0.0.1:13100"] }));
    app2.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app2).get("/ping");
    const csp = res.headers["content-security-policy"]!;
    expect(csp).toContain("connect-src");
    expect(csp).toContain("ws://127.0.0.1:13100");
  });

  it("vite-dev CSP relaxes script and style for tooling (Vite, MDXEditor)", async () => {
    const app2 = express();
    app2.use(cspNonceMiddleware);
    app2.use(createHelmet({ cspProfile: "vite-dev" }));
    app2.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app2).get("/ping");
    const csp = res.headers["content-security-policy"]!;
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("script-src");
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    expect(csp).toMatch(/worker-src[^;]*blob:/);
  });

  it("static-ui CSP keeps script nonce and relaxes style-src", async () => {
    const app2 = express();
    app2.use(cspNonceMiddleware);
    app2.use(createHelmet({ cspProfile: "static-ui" }));
    app2.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app2).get("/ping");
    const csp = res.headers["content-security-policy"]!;
    expect(csp).toMatch(/'nonce-[0-9a-f]{64}'/);
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });
});
