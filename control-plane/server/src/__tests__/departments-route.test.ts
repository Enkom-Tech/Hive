import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { departmentRoutes } from "../routes/departments.js";

const mockDepartmentsService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listMemberships: vi.fn(),
  upsertMembership: vi.fn(),
  removeMembership: vi.fn(),
  requireCompanyDepartment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  departmentService: () => mockDepartmentsService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
}));

function makeApp(principal: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = principal;
    next();
  });
  app.use("/api", departmentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("department routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentsService.list.mockResolvedValue([]);
    mockDepartmentsService.create.mockResolvedValue({
      id: "dep-1",
      companyId: "company-1",
      name: "Engineering",
      slug: "engineering",
      status: "active",
    });
  });

  it("denies create when user lacks departments:manage", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const app = makeApp({
      type: "user",
      id: "user-1",
      company_ids: ["company-1"],
      roles: [],
    });

    const res = await request(app).post("/api/companies/company-1/departments").send({
      name: "Engineering",
      slug: "engineering",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("departments:manage");
  });

  it("allows create when system principal is used", async () => {
    const app = makeApp({
      type: "system",
      id: "system",
      company_ids: ["company-1"],
      roles: ["instance_admin"],
    });

    const res = await request(app).post("/api/companies/company-1/departments").send({
      name: "Engineering",
      slug: "engineering",
    });

    expect(res.status).toBe(201);
    expect(mockDepartmentsService.create).toHaveBeenCalledWith("company-1", {
      name: "Engineering",
      slug: "engineering",
    });
  });
});
