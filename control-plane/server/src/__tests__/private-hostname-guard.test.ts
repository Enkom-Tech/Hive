import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

async function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const guard = privateHostnameGuard({
    enabled: opts.enabled,
    allowedHostnames: opts.allowedHostnames ?? [],
    bindHost: opts.bindHost ?? "0.0.0.0",
  });

  app.addHook("onRequest", (req, reply, done) => {
    guard(req.raw, reply.raw, done);
  });

  app.get("/api/health", async (_req, reply) => reply.status(200).send({ status: "ok" }));
  app.get("/dashboard", async (_req, reply) => reply.status(200).send("ok"));

  await app.ready();
  return app;
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const app = await createApp({ enabled: false });
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "dotta-macbook-pro:3100" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows loopback hostnames", async () => {
    const app = await createApp({ enabled: true });
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost:3100" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows explicitly configured hostnames", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "dotta-macbook-pro:3100" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "dotta-macbook-pro:3100" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()?.error).toContain("please run pnpm hive allowed-hostname dotta-macbook-pro");
    await app.close();
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await app.inject({ method: "GET", url: "/dashboard", headers: { host: "dotta-macbook-pro:3100" } });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("please run pnpm hive allowed-hostname dotta-macbook-pro");
    await app.close();
  });
});
