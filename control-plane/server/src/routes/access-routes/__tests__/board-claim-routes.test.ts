import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerBoardClaimRoutesF } from "../board-claim-routes.js";
import { createRouteTestFastify } from "../../../__tests__/helpers/route-app.js";

describe("registerBoardClaimRoutesF", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 400 for invalid board-claim query", async () => {
    const db = {} as import("@hive/db").Db;
    app = await createRouteTestFastify({
      plugin: async (fastify) => registerBoardClaimRoutesF(fastify, db),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/board-claim/x?code=not&code=a&code=string",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid query");
  });
});
