import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { departmentsPlugin } from "../routes/departments.js";

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

const db = {} as unknown as Db;

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
    const app = await createRouteTestFastify({
      plugin: (f) => departmentsPlugin(f, { db }),
      principal: {
        type: "user",
        id: "user-1",
        company_ids: ["company-1"],
        roles: [],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/departments",
      payload: { name: "Engineering", slug: "engineering" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("departments:manage");
    await app.close();
  });

  it("allows create when system principal is used", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => departmentsPlugin(f, { db }),
      principal: {
        type: "system",
        id: "system",
        roles: ["instance_admin"],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/departments",
      payload: { name: "Engineering", slug: "engineering" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockDepartmentsService.create).toHaveBeenCalledWith("company-1", {
      name: "Engineering",
      slug: "engineering",
    });
    await app.close();
  });
});
