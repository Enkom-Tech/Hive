import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { errorHandler } from "../middleware/index.js";

const getInstanceForRpc = vi.fn();
const parseCapabilitiesJson = vi.fn((raw: string) => {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
});

vi.mock("../services/plugins.js", () => ({
  pluginRegistryService: () => ({
    getInstanceForRpc,
    parseCapabilitiesJson,
  }),
}));

import { pluginHostRoutes } from "../routes/plugin-host.js";

const instanceId = "00000000-0000-4000-8000-000000000042";

describe("plugin host RPC", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing bearer token", async () => {
    const app = express();
    app.use(express.json());
    app.use("/internal/plugin-host", pluginHostRoutes(db, { hostSecret: "secret" }));
    app.use(errorHandler);
    const res = await request(app)
      .post("/internal/plugin-host/rpc")
      .send({ instanceId, method: "ping" });
    expect(res.status).toBe(401);
  });

  it("rejects wrong bearer token", async () => {
    const app = express();
    app.use(express.json());
    app.use("/internal/plugin-host", pluginHostRoutes(db, { hostSecret: "secret" }));
    app.use(errorHandler);
    const res = await request(app)
      .post("/internal/plugin-host/rpc")
      .set("Authorization", "Bearer wrong")
      .send({ instanceId, method: "ping" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when plugin instance is missing", async () => {
    getInstanceForRpc.mockResolvedValue(null);
    const app = express();
    app.use(express.json());
    app.use("/internal/plugin-host", pluginHostRoutes(db, { hostSecret: "secret" }));
    app.use(errorHandler);
    const res = await request(app)
      .post("/internal/plugin-host/rpc")
      .set("Authorization", "Bearer secret")
      .send({ instanceId, method: "ping" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("returns 404 when plugin instance is disabled", async () => {
    getInstanceForRpc.mockResolvedValue({
      id: instanceId,
      enabled: false,
      capabilitiesJson: '["rpc.ping"]',
      deploymentId: "d1",
    });
    const app = express();
    app.use(express.json());
    app.use("/internal/plugin-host", pluginHostRoutes(db, { hostSecret: "secret" }));
    app.use(errorHandler);
    const res = await request(app)
      .post("/internal/plugin-host/rpc")
      .set("Authorization", "Bearer secret")
      .send({ instanceId, method: "ping" });
    expect(res.status).toBe(404);
  });

  it("returns 403 when rpc.ping capability is missing", async () => {
    getInstanceForRpc.mockResolvedValue({
      id: instanceId,
      enabled: true,
      capabilitiesJson: "[]",
      deploymentId: "d1",
    });
    const app = express();
    app.use(express.json());
    app.use("/internal/plugin-host", pluginHostRoutes(db, { hostSecret: "secret" }));
    app.use(errorHandler);
    const res = await request(app)
      .post("/internal/plugin-host/rpc")
      .set("Authorization", "Bearer secret")
      .send({ instanceId, method: "ping" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: "Missing rpc.ping capability" });
  });

  it("returns 200 ping when token, instance, and capability are valid", async () => {
    getInstanceForRpc.mockResolvedValue({
      id: instanceId,
      enabled: true,
      capabilitiesJson: '["rpc.ping"]',
      deploymentId: "d1",
    });
    const app = express();
    app.use(express.json());
    app.use("/internal/plugin-host", pluginHostRoutes(db, { hostSecret: "secret" }));
    app.use(errorHandler);
    const res = await request(app)
      .post("/internal/plugin-host/rpc")
      .set("Authorization", "Bearer secret")
      .send({ instanceId, method: "ping" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, method: "ping" });
  });
});
