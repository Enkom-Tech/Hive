import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { Db } from "@hive/db";
import { companyEventsSSEPlugin } from "../routes/events-sse.js";

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

async function buildApp() {
  const db = {} as unknown as Db;
  const app = Fastify({ logger: false });
  await app.register(companyEventsSSEPlugin, {
    db,
    deploymentMode: "local_trusted",
  });
  await app.ready();
  return app;
}

describe("GET /api/companies/:companyId/events (SSE)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when authorization fails", async () => {
    authorizeCompanyEventsAccess.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/companies/company-1/events",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Forbidden" });
    await app.close();
  });

  it("returns 200 with event-stream and sends connected event when authorized", async () => {
    authorizeCompanyEventsAccess.mockResolvedValue({
      companyId: "company-1",
      actorType: "board",
      actorId: "board",
    });

    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/companies/company-1/events`, {
        signal: ac.signal,
      });
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
      await app.close();
    }
  }, 10_000);

  it("accepts token from query string for EventSource auth", async () => {
    authorizeCompanyEventsAccess.mockResolvedValue({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const ac = new AbortController();
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/companies/company-1/events?token=secret`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(authorizeCompanyEventsAccess).toHaveBeenCalledWith(
        expect.anything(),
        "company-1",
        expect.objectContaining({ token: "secret", deploymentMode: "local_trusted" }),
      );
      ac.abort();
    } finally {
      await app.close();
    }
  }, 10_000);
});
