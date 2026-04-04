import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { registerInviteRoutesF } from "../invite-routes.js";
import { createRouteTestFastify } from "../../../__tests__/helpers/route-app.js";

const noop = async () => {};

describe("registerInviteRoutesF", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 400 for invalid test-resolution query (missing url)", async () => {
    const db = {} as Db;
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerInviteRoutesF(fastify, {
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
        }),
    });
    const res = await app.inject({ method: "GET", url: "/api/invites/some-token/test-resolution" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid query");
  });
});
