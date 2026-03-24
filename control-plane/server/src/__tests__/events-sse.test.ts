import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { Db } from "@hive/db";
import { createCompanyEventsSSEHandler } from "../routes/events-sse.js";

const authorizeCompanyEventsAccess = vi.fn();
vi.mock("../realtime/company-events-auth.js", () => ({
  authorizeCompanyEventsAccess: (...args: unknown[]) => authorizeCompanyEventsAccess(...args),
}));

vi.mock("../services/live-events.js", () => ({
  subscribeCompanyLiveEvents: vi.fn(() => () => {}),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function appWithSSE(db: Db) {
  const app = express();
  app.get(
    "/api/companies/:companyId/events",
    createCompanyEventsSSEHandler(db, { deploymentMode: "local_trusted" }),
  );
  return app;
}

describe("GET /api/companies/:companyId/events (SSE)", () => {
  const db = {} as Db;

  it("returns 403 when authorization fails", async () => {
    authorizeCompanyEventsAccess.mockResolvedValue(null);
    const app = appWithSSE(db);
    const server = createServer(app);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== "string" && addr.port) resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/companies/company-1/events`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: "Forbidden" });
    } finally {
      server.close();
    }
  });

  it("returns 200 with event-stream and sends connected event when authorized", async () => {
    authorizeCompanyEventsAccess.mockResolvedValue({
      companyId: "company-1",
      actorType: "board",
      actorId: "board",
    });
    const app = appWithSSE(db);
    const server = createServer(app);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== "string" && addr.port) resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
    try {
      const ac = new AbortController();
      const resPromise = fetch(`http://127.0.0.1:${port}/api/companies/company-1/events`, {
        signal: ac.signal,
      });
      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let chunk = "";
      for (let i = 0; i < 5; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        chunk += decoder.decode(value);
        if (chunk.includes("connected")) break;
      }
      ac.abort();
      expect(chunk).toContain("connected");
      expect(chunk).toContain("type");
    } finally {
      server.close();
    }
  });

  it("accepts token from query string for EventSource auth", async () => {
    authorizeCompanyEventsAccess.mockResolvedValue({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
    });
    const app = appWithSSE(db);
    const server = createServer(app);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== "string" && addr.port) resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
    try {
      const ac = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/api/companies/company-1/events?token=secret`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(authorizeCompanyEventsAccess).toHaveBeenCalledWith(
        db,
        "company-1",
        expect.objectContaining({ token: "secret", deploymentMode: "local_trusted" }),
      );
      ac.abort();
    } finally {
      server.close();
    }
  });
});
