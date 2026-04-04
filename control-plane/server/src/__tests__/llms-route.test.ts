/// <reference path="../types/fastify.d.ts" />
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { actorBoard, actorAgent } from "./helpers/route-app.js";
import { llmPlugin } from "../routes/llms.js";
import { HttpError } from "../errors.js";
import { ZodError } from "zod";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

async function buildApp(principal = actorBoard(["company-1"])) {
  const db = {} as unknown as Db;
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req) => {
    req.principal = principal;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.status).send({ error: err.message });
      return;
    }
    if (err instanceof ZodError) {
      void reply.status(400).send({ error: "Validation error", details: err.issues });
      return;
    }
    void reply.status(500).send({ error: "Internal server error" });
  });

  await app.register(llmPlugin, { db });
  await app.ready();
  return app;
}

describe("llms route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /llms/agent-configuration.txt", () => {
    it("returns 200 when board actor (no agent permission check)", async () => {
      const app = await buildApp(actorBoard(["company-1"]));
      const res = await app.inject({ method: "GET", url: "/llms/agent-configuration.txt" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.body).toContain("Hive Agent Configuration Index");
      expect(mockAgentService.getById).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 403 when agent has no canCreateAgents permission", async () => {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", permissions: {}, role: "general" });
      const app = await buildApp(actorAgent("company-1", "agent-1"));
      const res = await app.inject({ method: "GET", url: "/llms/agent-configuration.txt" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      expect(res.json().error).toContain("permission");
      await app.close();
    });

    it("returns 200 when agent has canCreateAgents permission", async () => {
      mockAgentService.getById.mockResolvedValue({
        id: "agent-1",
        permissions: { canCreateAgents: true },
        role: "general",
      });
      const app = await buildApp(actorAgent("company-1", "agent-1"));
      const res = await app.inject({ method: "GET", url: "/llms/agent-configuration.txt" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Hive Agent Configuration Index");
      await app.close();
    });
  });

  describe("GET /llms/agent-icons.txt", () => {
    it("returns 200 with agent icon list for board actor", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/llms/agent-icons.txt" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.body).toContain("Hive Agent Icon Names");
      await app.close();
    });
  });

  describe("GET /llms/agent-configuration/:adapterType.txt", () => {
    it("returns 404 for unknown adapter type", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/llms/agent-configuration/nonexistent_adapter_xyz.txt",
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.body).toContain("Unknown adapter type");
      expect(res.body).toContain("nonexistent_adapter_xyz");
      await app.close();
    });
  });
});
