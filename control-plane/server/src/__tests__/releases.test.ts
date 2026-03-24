import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { releaseRoutes } from "../routes/releases.js";
import { clearReleaseCheckCache, setReleaseCheckConfig } from "../services/release-check.js";

describe("GET /api/releases/check", () => {
  const app = express();
  app.use("/api/releases", releaseRoutes());

  beforeEach(() => {
    clearReleaseCheckCache();
    setReleaseCheckConfig({ releasesRepo: undefined, updateCheckDisabled: false });
    vi.restoreAllMocks();
  });

  it("returns 200 with currentVersion", async () => {
    const res = await request(app).get("/api/releases/check");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("currentVersion");
    expect(typeof res.body.currentVersion).toBe("string");
    expect(res.body.currentVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("when update check disabled, returns only currentVersion", async () => {
    setReleaseCheckConfig({ releasesRepo: undefined, updateCheckDisabled: true });
    const res = await request(app).get("/api/releases/check");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("currentVersion");
    expect(res.body).not.toHaveProperty("latestVersion");
    expect(res.body).not.toHaveProperty("releasesUrl");
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

    const res = await request(app).get("/api/releases/check");
    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBeDefined();
    expect(res.body.latestVersion).toBe("0.99.0");
    expect(res.body.releasesUrl).toMatch(/^https:\/\/github\.com\/.+\/.+\/releases$/);
  });

  it("on GitHub fetch failure, returns 200 with only currentVersion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network error"))));

    const res = await request(app).get("/api/releases/check");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("currentVersion");
    expect(res.body.latestVersion).toBeUndefined();
    expect(res.body.releasesUrl).toBeUndefined();
  });

  it("on GitHub 404, returns 200 with only currentVersion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );

    const res = await request(app).get("/api/releases/check");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("currentVersion");
    expect(res.body.latestVersion).toBeUndefined();
    expect(res.body.releasesUrl).toBeUndefined();
  });
});
