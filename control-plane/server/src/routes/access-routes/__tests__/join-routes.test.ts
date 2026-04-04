import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { registerJoinRoutesF } from "../join-routes.js";
import { createRouteTestFastify, principalBoard } from "../../../__tests__/helpers/route-app.js";

function mockDbForJoinList(): Db {
  const chain = {
    orderBy: () => Promise.resolve([]),
    where: () => chain,
    from: () => chain,
  };
  return { select: () => chain } as unknown as Db;
}

describe("registerJoinRoutesF", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 400 for invalid join-requests list query", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerJoinRoutesF(fastify, {
          db: mockDbForJoinList(),
          access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
          agents: {} as ReturnType<typeof import("../../../services/index.js").agentService>,
          secretsSvc: {} as ReturnType<typeof import("../../../services/index.js").secretService>,
          joinAllowedAdapterTypes: null,
        }),
      principal: principalBoard({ companyIds: [], isSystem: true }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/companies/c1/join-requests?status=not_a_real_status",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid query");
  });

  it("returns 400 for claim-api-key body with short claimSecret", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerJoinRoutesF(fastify, {
          db: {} as Db,
          access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
          agents: {} as ReturnType<typeof import("../../../services/index.js").agentService>,
          secretsSvc: {} as ReturnType<typeof import("../../../services/index.js").secretService>,
          joinAllowedAdapterTypes: null,
        }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/join-requests/request-id/claim-api-key",
      payload: { claimSecret: "short" },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });
});
