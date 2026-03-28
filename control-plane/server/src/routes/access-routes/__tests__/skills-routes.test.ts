import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerSkillsRoutes } from "../skills-routes.js";
import { errorHandler } from "../../../middleware/error-handler.js";

describe("registerSkillsRoutes", () => {
  it("returns 200 for skills index", async () => {
    const app = express();
    const router = express.Router();
    registerSkillsRoutes(router);
    app.use(router);
    app.use(errorHandler);
    const res = await request(app).get("/skills/index");
    expect(res.status).toBe(200);
    expect(res.body.skills?.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown skill", async () => {
    const app = express();
    const router = express.Router();
    registerSkillsRoutes(router);
    app.use(router);
    app.use(errorHandler);
    const res = await request(app).get("/skills/__nonexistent_skill_xyz__");
    expect(res.status).toBe(404);
  });
});
