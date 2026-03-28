import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@hive/db";
import { registerMembersRoutes } from "../members-routes.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { principalBoard, principalNone } from "../../../__tests__/helpers/route-app.js";

describe("registerMembersRoutes", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { principal: unknown }).principal = principalNone();
      next();
    });
    const router = express.Router();
    registerMembersRoutes(router, {
      db: {} as Db,
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app).get("/companies/c1/members");
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid permissions patch body", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { principal: unknown }).principal = principalBoard({
        companyIds: ["c1"],
        isSystem: true,
      });
      next();
    });
    const router = express.Router();
    registerMembersRoutes(router, {
      db: {} as Db,
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app).patch("/companies/c1/members/m1/permissions").send({});
    expect(res.status).toBe(400);
  });
});
