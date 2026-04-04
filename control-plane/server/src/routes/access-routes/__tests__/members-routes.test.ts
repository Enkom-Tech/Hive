import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { registerMembersRoutesF } from "../members-routes.js";
import { createRouteTestFastify, principalNone, principalBoard } from "../../../__tests__/helpers/route-app.js";

describe("registerMembersRoutesF", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 401 when unauthenticated", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerMembersRoutesF(fastify, {
          db: {} as Db,
          access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
        }),
      principal: principalNone(),
    });
    const res = await app.inject({ method: "GET", url: "/api/companies/c1/members" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for invalid permissions patch body", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerMembersRoutesF(fastify, {
          db: {} as Db,
          access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
        }),
      principal: principalBoard({ companyIds: ["c1"], isSystem: true }),
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/companies/c1/members/m1/permissions",
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });
});
