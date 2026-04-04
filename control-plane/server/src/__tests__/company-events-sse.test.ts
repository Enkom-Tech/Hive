/// <reference path="../types/fastify.d.ts" />
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { companyEventsSSEPlugin } from "../routes/events-sse.js";

const COMPANY = "company-sse-test";

// Mock authorizeCompanyEventsAccess so tests don't need a real DB.
const mockAuthorize = vi.hoisted(() => vi.fn());
vi.mock("../realtime/company-events-auth.js", () => ({
  authorizeCompanyEventsAccess: mockAuthorize,
}));

// Mock subscribeCompanyLiveEvents — we just need a no-op unsubscribe handle.
const mockUnsubscribe = vi.hoisted(() => vi.fn());
vi.mock("../services/live-events.js", () => ({
  subscribeCompanyLiveEvents: vi.fn(() => mockUnsubscribe),
}));

async function buildApp() {
  const db = {} as unknown as Db;
  const app = Fastify({ logger: false });
  await app.register(companyEventsSSEPlugin, {
    db,
    deploymentMode: "authenticated",
  });
  await app.ready();
  return app;
}

describe("companyEventsSSEPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Each test builds its own app — nothing to clean up at module level.
  });

  it("returns 403 when authorization fails", async () => {
    mockAuthorize.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/companies/${COMPANY}/events`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "Forbidden" });
    await app.close();
  });

  it("passes bearer token to authorization", async () => {
    mockAuthorize.mockResolvedValue(null);
    const app = await buildApp();

    await app.inject({
      method: "GET",
      url: `/api/companies/${COMPANY}/events`,
      headers: { authorization: "Bearer my-agent-token" },
    });

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      expect.objectContaining({ token: "my-agent-token" }),
    );
    await app.close();
  });

  it("passes query token when no bearer header is present", async () => {
    mockAuthorize.mockResolvedValue(null);
    const app = await buildApp();

    await app.inject({
      method: "GET",
      url: `/api/companies/${COMPANY}/events?token=query-token-123`,
    });

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      expect.objectContaining({ token: "query-token-123" }),
    );
    await app.close();
  });

  it("bearer token takes precedence over query token", async () => {
    mockAuthorize.mockResolvedValue(null);
    const app = await buildApp();

    await app.inject({
      method: "GET",
      url: `/api/companies/${COMPANY}/events?token=query-token`,
      headers: { authorization: "Bearer header-token" },
    });

    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      expect.objectContaining({ token: "header-token" }),
    );
    await app.close();
  });

  it("writes SSE headers and connected event when authorized", async () => {
    mockAuthorize.mockResolvedValue({
      companyId: COMPANY,
      actorType: "agent",
      actorId: "agent-1",
    });
    const app = await buildApp();

    // Start a real HTTP server so we can use a real fetch + AbortController.
    // inject() does not fire socket close events, so the heartbeat would keep
    // the inject pending indefinitely.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/companies/${COMPANY}/events`, {
      headers: { authorization: "Bearer valid-agent-token" },
      signal: ac.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    // Read the first chunk (the "connected" data line) then abort.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    ac.abort();

    expect(chunk).toContain('"type":"connected"');
    await app.close();
  }, 10_000);
});
