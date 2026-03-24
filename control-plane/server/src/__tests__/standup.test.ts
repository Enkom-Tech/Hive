import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_STATUS_DONE } from "@hive/shared";
import { notFound } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { standupRoutes } from "../routes/standup.js";

const getReportMock = vi.fn();

vi.mock("../services/standup.js", () => ({
  standupService: () => ({ getReport: getReportMock }),
}));

function createApp(actor: {
  type: "board" | "agent" | "none";
  userId?: string;
  agentId?: string;
  companyId?: string;
  source?: string;
}) {
  const app = express();
  app.use((req, _res, next) => {
    if (actor.type === "none") {
      req.principal = null;
    } else if (actor.type === "board") {
      req.principal =
        actor.source === "session"
          ? { type: "user", id: actor.userId ?? "board", company_ids: [], roles: [] }
          : { type: "system", id: actor.userId ?? "board", roles: [] };
    } else {
      req.principal = {
        type: "agent",
        id: actor.agentId ?? "agent-1",
        company_id: actor.companyId ?? "company-A",
        roles: [],
      };
    }
    next();
  });
  app.use(standupRoutes({} as any));
  app.use(errorHandler);
  return app;
}

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

describe("GET /companies/:companyId/standup", () => {
  beforeEach(() => {
    getReportMock.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createApp({ type: "none" });
    const res = await request(app).get(`/companies/${companyA}/standup`);
    expect(res.status).toBe(401);
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it("returns 403 when agent key calls with another company id", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: companyA,
    });
    const otherCompanyId = "660e8400-e29b-41d4-a716-446655440001";
    const res = await request(app).get(`/companies/${otherCompanyId}/standup`);
    expect(res.status).toBe(403);
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it("returns 200 with report shape when board calls", async () => {
    getReportMock.mockResolvedValueOnce(sampleReport);
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/companies/${companyA}/standup`);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyA);
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(Array.isArray(res.body.teamAccomplishments)).toBe(true);
    expect(Array.isArray(res.body.blockers)).toBe(true);
    expect(Array.isArray(res.body.overdue)).toBe(true);
    expect(res.body.generatedAt).toBeDefined();
    expect(getReportMock).toHaveBeenCalledWith(companyA);
  });

  it("returns 200 when agent key calls with own company id", async () => {
    getReportMock.mockResolvedValueOnce(sampleReport);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: companyA,
    });
    const res = await request(app).get(`/companies/${companyA}/standup`);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyA);
    expect(getReportMock).toHaveBeenCalledWith(companyA);
  });

  it("returns 404 when company does not exist", async () => {
    getReportMock.mockRejectedValueOnce(notFound("Company not found"));
    const app = createApp({ type: "board" });
    const res = await request(app).get(`/companies/${companyA}/standup`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Company not found");
  });
});
