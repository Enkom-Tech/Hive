import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { unauthorized } from "../../../errors.js";
import { registerAdminAccessRoutes } from "../admin-access-routes.js";
import { errorHandler } from "../../../middleware/error-handler.js";

describe("registerAdminAccessRoutes", () => {
  it("returns 401 when assertInstanceAdmin rejects", async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAdminAccessRoutes(router, {
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
      assertInstanceAdmin: async () => {
        throw unauthorized();
      },
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app).post("/admin/users/u1/promote-instance-admin");
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid company-access put body", async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAdminAccessRoutes(router, {
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
      assertInstanceAdmin: async () => {},
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app)
      .put("/admin/users/u1/company-access")
      .send({ companyIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
  });
});
