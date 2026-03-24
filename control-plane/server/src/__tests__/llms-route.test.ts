import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestApp, actorBoard, actorAgent } from "./helpers/route-app.js";
import { llmRoutes } from "../routes/llms.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

describe("llms route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/llms/agent-configuration.txt", () => {
    it("returns 200 when board actor (no agent permission check)", async () => {
      const app = createRouteTestApp({
        router: llmRoutes(db),
        principal: actorBoard(["company-1"]),
      });
      const res = await request(app).get("/api/llms/agent-configuration.txt");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.text).toContain("Hive Agent Configuration Index");
      expect(mockAgentService.getById).not.toHaveBeenCalled();
    });

    it("returns 403 when agent has no canCreateAgents permission", async () => {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", permissions: {}, role: "general" });
      const app = createRouteTestApp({
        router: llmRoutes(db),
        principal: actorAgent("company-1", "agent-1"),
      });
      const res = await request(app).get("/api/llms/agent-configuration.txt");
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(res.body.error).toContain("permission");
    });

    it("returns 200 when agent has canCreateAgents permission", async () => {
      mockAgentService.getById.mockResolvedValue({
        id: "agent-1",
        permissions: { canCreateAgents: true },
        role: "general",
      });
      const app = createRouteTestApp({
        router: llmRoutes(db),
        principal: actorAgent("company-1", "agent-1"),
      });
      const res = await request(app).get("/api/llms/agent-configuration.txt");
      expect(res.status).toBe(200);
      expect(res.text).toContain("Hive Agent Configuration Index");
    });
  });

  describe("GET /api/llms/agent-configuration/:adapterType.txt", () => {
    it("returns 404 for unknown adapter type", async () => {
      const app = createRouteTestApp({
        router: llmRoutes(db),
        principal: actorBoard(["company-1"]),
      });
      const res = await request(app).get("/api/llms/agent-configuration/nonexistent_adapter_xyz.txt");
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.text).toContain("Unknown adapter type");
      expect(res.text).toContain("nonexistent_adapter_xyz");
    });
  });
});
