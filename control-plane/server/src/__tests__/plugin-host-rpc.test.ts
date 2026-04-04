import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { createRouteTestFastify } from "./helpers/route-app.js";

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

import { pluginHostPlugin } from "../routes/plugin-host.js";

const instanceId = "00000000-0000-4000-8000-000000000042";

describe("plugin host RPC", () => {
  const db = {} as unknown as Db;
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(): Promise<FastifyInstance> {
    return createRouteTestFastify({
      plugin: async (fastify) => {
        await pluginHostPlugin(fastify, { db, hostSecret: "secret" });
      },
    });
  }

  it("rejects missing bearer token", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/plugin-host/rpc",
      payload: { instanceId, method: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects wrong bearer token", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/plugin-host/rpc",
      headers: { authorization: "Bearer wrong" },
      payload: { instanceId, method: "ping" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when plugin instance is missing", async () => {
    getInstanceForRpc.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/plugin-host/rpc",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId, method: "ping" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it("returns 404 when plugin instance is disabled", async () => {
    getInstanceForRpc.mockResolvedValue({
      id: instanceId,
      enabled: false,
      capabilitiesJson: '["rpc.ping"]',
      deploymentId: "d1",
    });
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/plugin-host/rpc",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId, method: "ping" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when rpc.ping capability is missing", async () => {
    getInstanceForRpc.mockResolvedValue({
      id: instanceId,
      enabled: true,
      capabilitiesJson: "[]",
      deploymentId: "d1",
    });
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/plugin-host/rpc",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId, method: "ping" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: "Missing rpc.ping capability" });
  });

  it("returns 200 ping when token, instance, and capability are valid", async () => {
    getInstanceForRpc.mockResolvedValue({
      id: instanceId,
      enabled: true,
      capabilitiesJson: '["rpc.ping"]',
      deploymentId: "d1",
    });
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/plugin-host/rpc",
      headers: { authorization: "Bearer secret" },
      payload: { instanceId, method: "ping" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, method: "ping" });
  });
});
