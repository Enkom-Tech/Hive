import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerBoardClaimRoutes } from "../board-claim-routes.js";
import { errorHandler } from "../../../middleware/index.js";

describe("registerBoardClaimRoutes", () => {
  it("returns 400 for invalid board-claim query", async () => {
    const app = express();
    const router = express.Router();
    const db = {} as import("@hive/db").Db;
    registerBoardClaimRoutes(router, db);
    app.use(router);
    app.use(errorHandler);
    const res = await request(app)
      .get("/board-claim/x")
      .query({ code: ["not", "a", "string"] as unknown as string });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
  });
});
