import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@hive/db";
import { registerInviteRoutes } from "../invite-routes.js";
import { errorHandler } from "../../../middleware/error-handler.js";

const noop = async () => {};

describe("registerInviteRoutes", () => {
  it("returns 400 for invalid test-resolution query (missing url)", async () => {
    const app = express();
    const router = express.Router();
    const db = {} as Db;
    registerInviteRoutes(router, {
      db,
      opts: {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "localhost",
        allowedHostnames: ["localhost"],
      },
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
      agents: {} as ReturnType<typeof import("../../../services/index.js").agentService>,
      secretsSvc: {} as ReturnType<typeof import("../../../services/index.js").secretService>,
      joinAllowedAdapterTypes: null,
      assertInstanceAdmin: noop,
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app).get("/invites/some-token/test-resolution");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
  });
});
