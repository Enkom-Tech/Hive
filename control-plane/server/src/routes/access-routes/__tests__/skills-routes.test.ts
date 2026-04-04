import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerSkillsRoutesF } from "../skills-routes.js";
import { createRouteTestFastify } from "../../../__tests__/helpers/route-app.js";

describe("registerSkillsRoutesF", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 200 for skills index", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => registerSkillsRoutesF(fastify),
    });
    const res = await app.inject({ method: "GET", url: "/api/skills/index" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skills?.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown skill", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => registerSkillsRoutesF(fastify),
    });
    const res = await app.inject({ method: "GET", url: "/api/skills/__nonexistent_skill_xyz__" });
    expect(res.statusCode).toBe(404);
  });
});
