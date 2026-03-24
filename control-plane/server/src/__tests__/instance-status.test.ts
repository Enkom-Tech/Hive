import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hiveDb from "@hive/db";
import { errorHandler } from "../middleware/error-handler.js";
import { instanceStatusRoutes } from "../routes/instance-status.js";

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

function createApp(actor: {
  type: "board" | "agent";
  userId?: string;
  roles?: string[];
  source?: "session" | "system";
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor.type === "agent") {
      req.principal = {
        type: "agent",
        id: actor.userId ?? "agent-1",
        company_id: "550e8400-e29b-41d4-a716-446655440000",
        roles: [],
      };
    } else if (actor.source === "system") {
      req.principal = { type: "system", id: actor.userId ?? "local", roles: [] };
    } else {
      req.principal = {
        type: "user",
        id: actor.userId ?? "user-1",
        company_ids: [],
        roles: actor.roles ?? [],
      };
    }
    next();
  });

  const api = express.Router();
  api.use(
    "/instance",
    instanceStatusRoutes({} as hiveDb.Db, {
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
    }),
  );
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

describe("instance status routes", () => {
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

  afterEach(() => {
    inspectSpy.mockRestore();
    delete process.env.HIVE_UI_MIGRATIONS_ENABLED;
  });

  it("GET /api/instance/status returns 403 for agents", async () => {
    const app = createApp({ type: "agent" });
    const res = await request(app).get("/api/instance/status");
    expect(res.status).toBe(403);
  });

  it("GET /api/instance/status returns 200 for board users", async () => {
    const app = createApp({ type: "board", roles: [] });
    const res = await request(app).get("/api/instance/status");
    expect(res.status).toBe(200);
    expect(res.body.appVersion).toBeDefined();
    expect(res.body.migration.status).toBe("upToDate");
    expect(res.body.workloadTop).toBeUndefined();
    expect(listTopCompaniesByWorkload).not.toHaveBeenCalled();
  });

  it("GET /api/instance/status includes workloadTop for instance admins", async () => {
    const app = createApp({ type: "board", roles: ["instance_admin"] });
    const res = await request(app).get("/api/instance/status");
    expect(res.status).toBe(200);
    expect(res.body.workloadTop).toHaveLength(1);
    expect(listTopCompaniesByWorkload).toHaveBeenCalledWith(50, 10);
  });

  it("GET /api/instance/status includes migration filenames for instance admins", async () => {
    const app = createApp({ type: "board", roles: ["instance_admin"] });
    const res = await request(app).get("/api/instance/status");
    expect(res.status).toBe(200);
    expect(res.body.migration.appliedMigrations).toEqual(["0001_foo.sql"]);
  });

  it("POST /api/instance/migrations/apply returns 403 for non-admin", async () => {
    process.env.HIVE_UI_MIGRATIONS_ENABLED = "1";
    const app = createApp({ type: "board", roles: [] });
    const res = await request(app).post("/api/instance/migrations/apply").send({});
    expect(res.status).toBe(403);
  });

  it("POST /api/instance/migrations/apply returns 403 when UI migrations disabled", async () => {
    process.env.HIVE_UI_MIGRATIONS_ENABLED = "0";
    const app = createApp({ type: "board", roles: ["instance_admin"] });
    const res = await request(app).post("/api/instance/migrations/apply").send({});
    expect(res.status).toBe(403);
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

    const app = createApp({ type: "board", roles: ["instance_admin"] });
    const res = await request(app).post("/api/instance/migrations/apply").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(applySpy).toHaveBeenCalled();
    applySpy.mockRestore();
  });
});
