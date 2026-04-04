import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { unauthorized } from "../../../errors.js";
import { registerAdminAccessRoutesF } from "../admin-access-routes.js";
import { createRouteTestFastify } from "../../../__tests__/helpers/route-app.js";

/** Minimal mock that causes isInstanceAdmin to reject so assertInstanceAdminF throws. */
function makeAccessWithDeniedAdmin() {
  return {
    isInstanceAdmin: async () => false,
  } as unknown as ReturnType<typeof import("../../../services/access.js").accessService>;
}

describe("registerAdminAccessRoutesF", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 401 when assertInstanceAdmin rejects", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerAdminAccessRoutesF(fastify, {
          access: {} as ReturnType<typeof import("../../../services/access.js").accessService>,
          assertInstanceAdmin: async () => {
            throw unauthorized();
          },
        }),
      // Provide a system principal so the internal assertInstanceAdminF passes — but we
      // also supply a non-admin user principal so the route correctly rejects non-admins.
      // Use an agent principal so the internal check throws unauthorized (type !== user/system).
      principal: { type: "agent", id: "agent-1", company_id: "company-1", roles: [] },
    });
    const res = await app.inject({ method: "POST", url: "/api/admin/users/u1/promote-instance-admin" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for invalid company-access put body", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) =>
        registerAdminAccessRoutesF(fastify, {
          access: {
            isInstanceAdmin: async () => true,
          } as unknown as ReturnType<typeof import("../../../services/access.js").accessService>,
          assertInstanceAdmin: async () => {},
        }),
      principal: { type: "user", id: "u1", company_ids: [], roles: ["instance_admin"] },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/users/u1/company-access",
      payload: { companyIds: ["not-a-uuid"] },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
  });
});
