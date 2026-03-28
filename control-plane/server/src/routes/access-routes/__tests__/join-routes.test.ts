import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@hive/db";
import { registerJoinRoutes } from "../join-routes.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { principalBoard } from "../../../__tests__/helpers/route-app.js";

function mockDbForJoinList(): Db {
  const chain = {
    orderBy: () => Promise.resolve([]),
    where: () => chain,
    from: () => chain,
  };
  return { select: () => chain } as unknown as Db;
}

describe("registerJoinRoutes", () => {
  it("returns 400 for invalid join-requests list query", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { principal: unknown }).principal = principalBoard({
        companyIds: [],
        isSystem: true,
      });
      next();
    });
    const router = express.Router();
    registerJoinRoutes(router, {
      db: mockDbForJoinList(),
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
      agents: {} as ReturnType<typeof import("../../../services/index.js").agentService>,
      secretsSvc: {} as ReturnType<typeof import("../../../services/index.js").secretService>,
      joinAllowedAdapterTypes: null,
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app)
      .get("/companies/c1/join-requests")
      .query({ status: "not_a_real_status" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
  });

  it("returns 400 for claim-api-key body with short claimSecret", async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerJoinRoutes(router, {
      db: {} as Db,
      access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
      agents: {} as ReturnType<typeof import("../../../services/index.js").agentService>,
      secretsSvc: {} as ReturnType<typeof import("../../../services/index.js").secretService>,
      joinAllowedAdapterTypes: null,
    });
    app.use(router);
    app.use(errorHandler);
    const res = await request(app)
      .post("/join-requests/request-id/claim-api-key")
      .send({ claimSecret: "short" });
    expect(res.status).toBe(400);
  });
});
