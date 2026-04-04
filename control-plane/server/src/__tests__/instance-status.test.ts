import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import * as hiveDb from "@hive/db";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { instanceStatusPlugin } from "../routes/instance-status.js";
import { principalBoard, principalAgent } from "./helpers/route-app.js";

const listTopCompaniesByWorkload = vi.fn();

vi.mock("../routes/health.js", () => ({
  collectHealthPayload: vi.fn().mockResolvedValue({
    status: "ok" as const,
    deploymentMode: "authenticated" as const,
    deploymentExposure: "private" as const,
    authReady: true,
    bootstrapStatus: "ready" as const,
    bootstrapInviteActive: false,
    auth: { signUpDisabled: true },
    features: { companyDeletionEnabled: true },
  }),
}));

vi.mock("../services/release-check.js", () => ({
  getReleaseCheck: vi.fn().mockResolvedValue({
    currentVersion: "0.9.0",
    latestVersion: "1.0.0",
    releasesUrl: "https://example.com/releases",
  }),
}));

vi.mock("../services/instance-scheduler-summary.js", () => ({
  loadInstanceSchedulerAgents: vi.fn().mockResolvedValue([]),
  summarizeSchedulerAgents: vi.fn().mockReturnValue({
    totalSchedulers: 0,
    activeCount: 0,
    staleCount: 0,
    maxStalenessSeconds: null,
  }),
}));

vi.mock("../services/workload.js", () => ({
  workloadService: () => ({
    getWorkload: vi.fn(),
    listTopCompaniesByWorkload,
  }),
}));

function makePlugin(principal: ReturnType<typeof principalBoard> | ReturnType<typeof principalAgent> | { type: "agent"; id: string; company_id: string; roles: never[] } | { type: "system"; id: string; roles: never[] }) {
  return async (fastify: FastifyInstance) => {
    await instanceStatusPlugin(fastify, {
      db: {} as hiveDb.Db,
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      authDisableSignUp: true,
      activeDatabaseConnectionString: "postgres://mock/mock",
      metricsEnabled: true,
      workload: {
        getWorkload: vi.fn(),
        listTopCompaniesByWorkload,
      } as any,
    });
  };
}

describe("instance status routes", () => {
  let app: FastifyInstance;
  let inspectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listTopCompaniesByWorkload.mockReset();
    listTopCompaniesByWorkload.mockResolvedValue([
      {
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        companyName: "Acme",
        action: "throttle" as const,
        reason: "Under load",
        details: ["Queue depth high"],
      },
    ]);

    inspectSpy = vi.spyOn(hiveDb, "inspectMigrations").mockResolvedValue({
      status: "upToDate",
      tableCount: 12,
      availableMigrations: ["0001_foo.sql"],
      appliedMigrations: ["0001_foo.sql"],
    });
  });

  afterEach(async () => {
    inspectSpy.mockRestore();
    delete process.env.HIVE_UI_MIGRATIONS_ENABLED;
    await app?.close();
  });

  it("GET /api/instance/status returns 403 for agents", async () => {
    app = await createRouteTestFastify({
      plugin: makePlugin(principalAgent({ agentId: "agent-1", companyId: "550e8400-e29b-41d4-a716-446655440000" })),
      principal: principalAgent({ agentId: "agent-1", companyId: "550e8400-e29b-41d4-a716-446655440000" }),
    });
    const res = await app.inject({ method: "GET", url: "/api/instance/status" });
    expect(res.statusCode).toBe(403);
  });

  it("GET /api/instance/status returns 200 for board users", async () => {
    app = await createRouteTestFastify({
      plugin: makePlugin(principalBoard({ companyIds: [], isSystem: false })),
      principal: principalBoard({ companyIds: [], isSystem: false }),
    });
    const res = await app.inject({ method: "GET", url: "/api/instance/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().appVersion).toBeDefined();
    expect(res.json().migration.status).toBe("upToDate");
    expect(res.json().workloadTop).toBeUndefined();
    expect(listTopCompaniesByWorkload).not.toHaveBeenCalled();
  });

  it("GET /api/instance/status includes workloadTop for instance admins", async () => {
    app = await createRouteTestFastify({
      plugin: makePlugin(principalBoard({ companyIds: [], isInstanceAdmin: true })),
      principal: principalBoard({ companyIds: [], isInstanceAdmin: true }),
    });
    const res = await app.inject({ method: "GET", url: "/api/instance/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().workloadTop).toHaveLength(1);
    expect(listTopCompaniesByWorkload).toHaveBeenCalledWith(50, 10);
  });

  it("GET /api/instance/status includes migration filenames for instance admins", async () => {
    app = await createRouteTestFastify({
      plugin: makePlugin(principalBoard({ companyIds: [], isInstanceAdmin: true })),
      principal: principalBoard({ companyIds: [], isInstanceAdmin: true }),
    });
    const res = await app.inject({ method: "GET", url: "/api/instance/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().migration.appliedMigrations).toEqual(["0001_foo.sql"]);
  });

  it("POST /api/instance/migrations/apply returns 403 for non-admin", async () => {
    process.env.HIVE_UI_MIGRATIONS_ENABLED = "1";
    app = await createRouteTestFastify({
      plugin: makePlugin(principalBoard({ companyIds: [], isSystem: false })),
      principal: principalBoard({ companyIds: [], isSystem: false }),
    });
    const res = await app.inject({ method: "POST", url: "/api/instance/migrations/apply", payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/instance/migrations/apply returns 403 when UI migrations disabled", async () => {
    process.env.HIVE_UI_MIGRATIONS_ENABLED = "0";
    app = await createRouteTestFastify({
      plugin: makePlugin(principalBoard({ companyIds: [], isInstanceAdmin: true })),
      principal: principalBoard({ companyIds: [], isInstanceAdmin: true }),
    });
    const res = await app.inject({ method: "POST", url: "/api/instance/migrations/apply", payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/instance/migrations/apply runs when enabled and pending", async () => {
    process.env.HIVE_UI_MIGRATIONS_ENABLED = "1";
    inspectSpy.mockResolvedValue({
      status: "needsMigrations",
      tableCount: 12,
      availableMigrations: ["0001_foo.sql", "0002_bar.sql"],
      appliedMigrations: ["0001_foo.sql"],
      pendingMigrations: ["0002_bar.sql"],
      reason: "pending-migrations",
    });
    const applySpy = vi.spyOn(hiveDb, "applyPendingMigrations").mockResolvedValue(undefined);
    inspectSpy
      .mockResolvedValueOnce({
        status: "needsMigrations",
        tableCount: 12,
        availableMigrations: ["0001_foo.sql", "0002_bar.sql"],
        appliedMigrations: ["0001_foo.sql"],
        pendingMigrations: ["0002_bar.sql"],
        reason: "pending-migrations",
      })
      .mockResolvedValueOnce({
        status: "upToDate",
        tableCount: 12,
        availableMigrations: ["0001_foo.sql", "0002_bar.sql"],
        appliedMigrations: ["0001_foo.sql", "0002_bar.sql"],
      });

    app = await createRouteTestFastify({
      plugin: makePlugin(principalBoard({ companyIds: [], isInstanceAdmin: true })),
      principal: principalBoard({ companyIds: [], isInstanceAdmin: true }),
    });
    const res = await app.inject({ method: "POST", url: "/api/instance/migrations/apply", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(applySpy).toHaveBeenCalled();
    applySpy.mockRestore();
  });
});
