import { describe, it, expect, afterAll } from "vitest";
import Fastify from "fastify";
import { healthPlugin } from "../routes/health.js";

describe("GET /health", () => {
  const app = Fastify({ logger: false });
  app.register(healthPlugin, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
    authDisableSignUp: false,
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with status ok (no db)", async () => {
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });
});
