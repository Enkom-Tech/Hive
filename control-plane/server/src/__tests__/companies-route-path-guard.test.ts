import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { companiesPlugin } from "../routes/companies/index.js";
import { createRouteTestFastify } from "./helpers/route-app.js";

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  agentService: () => ({
    createWorkerInstanceLinkEnrollmentToken: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

describe("company routes malformed issue path guard", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns a clear error when companyId is missing for issues list path", async () => {
    app = await createRouteTestFastify({
      plugin: async (fastify) => companiesPlugin(fastify, { db: {} as import("@hive/db").Db }),
    });

    const res = await app.inject({ method: "GET", url: "/api/companies/issues" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });
});
