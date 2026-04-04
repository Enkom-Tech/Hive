import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import type { Principal } from "@hive/shared";
import { ISSUE_STATUS_DONE } from "@hive/shared";
import { notFound } from "../errors.js";
import { createRouteTestFastify } from "./helpers/route-app.js";
import { standupPlugin } from "../routes/standup.js";

const getReportMock = vi.fn();

vi.mock("../services/standup.js", () => ({
  standupService: () => ({ getReport: getReportMock }),
}));

const db = {} as unknown as Db;

const companyA = "550e8400-e29b-41d4-a716-446655440000";

const sampleReport = {
  companyId: companyA,
  generatedAt: new Date().toISOString(),
  agents: [
    {
      agentId: "agent-1",
      name: "Agent One",
      completed: [{ id: "i1", identifier: "P-1", title: "Done task", status: ISSUE_STATUS_DONE, startedAt: null, completedAt: "2024-01-01T12:00:00Z", assigneeAgentId: "agent-1" }],
      inProgress: [],
      assigned: [],
      review: [],
      blocked: [],
    },
  ],
  teamAccomplishments: [],
  blockers: [],
  overdue: [],
};

describe("GET /api/companies/:companyId/standup", () => {
  beforeEach(() => {
    getReportMock.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = await createRouteTestFastify({
      plugin: (f) => standupPlugin(f, { db }),
      principal: null,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/standup` });
    expect(res.statusCode).toBe(401);
    expect(getReportMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const principal: Principal = {
      type: "agent",
      id: "agent-1",
      company_id: companyA,
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => standupPlugin(f, { db }),
      principal,
    });
    const otherCompanyId = "660e8400-e29b-41d4-a716-446655440001";
    const res = await app.inject({ method: "GET", url: `/api/companies/${otherCompanyId}/standup` });
    expect(res.statusCode).toBe(403);
    expect(getReportMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 200 with report shape when board calls", async () => {
    getReportMock.mockResolvedValueOnce(sampleReport);
    const principal: Principal = {
      type: "system",
      id: "board",
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => standupPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/standup` });
    expect(res.statusCode).toBe(200);
    expect(res.json().companyId).toBe(companyA);
    expect(Array.isArray(res.json().agents)).toBe(true);
    expect(Array.isArray(res.json().teamAccomplishments)).toBe(true);
    expect(Array.isArray(res.json().blockers)).toBe(true);
    expect(Array.isArray(res.json().overdue)).toBe(true);
    expect(res.json().generatedAt).toBeDefined();
    expect(getReportMock).toHaveBeenCalledWith(companyA);
    await app.close();
  });

  it("returns 200 when agent key calls with own company id", async () => {
    getReportMock.mockResolvedValueOnce(sampleReport);
    const principal: Principal = {
      type: "agent",
      id: "agent-1",
      company_id: companyA,
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => standupPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/standup` });
    expect(res.statusCode).toBe(200);
    expect(res.json().companyId).toBe(companyA);
    expect(getReportMock).toHaveBeenCalledWith(companyA);
    await app.close();
  });

  it("returns 404 when company does not exist", async () => {
    getReportMock.mockRejectedValueOnce(notFound("Company not found"));
    const principal: Principal = {
      type: "system",
      id: "board",
      roles: [],
    };
    const app = await createRouteTestFastify({
      plugin: (f) => standupPlugin(f, { db }),
      principal,
    });
    const res = await app.inject({ method: "GET", url: `/api/companies/${companyA}/standup` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Company not found");
    await app.close();
  });
});
