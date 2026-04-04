import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { releasesPlugin } from "../routes/releases.js";
import { clearReleaseCheckCache, setReleaseCheckConfig } from "../services/release-check.js";
import { createRouteTestFastify } from "./helpers/route-app.js";

describe("GET /api/releases/check", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    clearReleaseCheckCache();
    setReleaseCheckConfig({ releasesRepo: undefined, updateCheckDisabled: false });
    vi.restoreAllMocks();
    app = await createRouteTestFastify({ plugin: releasesPlugin, prefix: "/api" });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with currentVersion", async () => {
    const res = await app.inject({ method: "GET", url: "/api/releases/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("currentVersion");
    expect(typeof res.json().currentVersion).toBe("string");
    expect(res.json().currentVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("when update check disabled, returns only currentVersion", async () => {
    setReleaseCheckConfig({ releasesRepo: undefined, updateCheckDisabled: true });
    const res = await app.inject({ method: "GET", url: "/api/releases/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("currentVersion");
    expect(res.json()).not.toHaveProperty("latestVersion");
    expect(res.json()).not.toHaveProperty("releasesUrl");
  });

  it("when mock GitHub returns newer tag, response includes latestVersion and releasesUrl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ tag_name: "v0.99.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const res = await app.inject({ method: "GET", url: "/api/releases/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentVersion).toBeDefined();
    expect(res.json().latestVersion).toBe("0.99.0");
    expect(res.json().releasesUrl).toMatch(/^https:\/\/github\.com\/.+\/.+\/releases$/);
  });

  it("on GitHub fetch failure, returns 200 with only currentVersion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network error"))));

    const res = await app.inject({ method: "GET", url: "/api/releases/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("currentVersion");
    expect(res.json().latestVersion).toBeUndefined();
    expect(res.json().releasesUrl).toBeUndefined();
  });

  it("on GitHub 404, returns 200 with only currentVersion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );

    const res = await app.inject({ method: "GET", url: "/api/releases/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("currentVersion");
    expect(res.json().latestVersion).toBeUndefined();
    expect(res.json().releasesUrl).toBeUndefined();
  });
});
