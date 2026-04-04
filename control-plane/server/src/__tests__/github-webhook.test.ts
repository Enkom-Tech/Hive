/// <reference path="../types/fastify.d.ts" />
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { githubWebhookPlugin } from "../routes/integrations-github.js";

// Mock the downstream services so the handler can run without a real DB.
const mockProcessPr = vi.hoisted(() => vi.fn());
vi.mock("../services/vcs-github-webhook.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/vcs-github-webhook.js")>();
  return { ...mod, processGithubPullRequestMerge: mockProcessPr };
});

const mockInsert = vi.hoisted(() => ({
  values: vi.fn().mockReturnThis(),
  onConflictDoNothing: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: "delivery-row-1" }]),
}));

const SECRET = "test-webhook-secret";
const COMPANY = "company-abc";

function makeSignature(body: Buffer | string, secret = SECRET) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return "sha256=" + createHmac("sha256", secret).update(buf).digest("hex");
}

async function buildApp(opts?: Partial<Parameters<typeof githubWebhookPlugin>[1]>) {
  const mockDb = {
    insert: () => mockInsert,
  } as unknown as Db;

  const app = Fastify({ logger: false });
  await app.register(githubWebhookPlugin, {
    enabled: true,
    secret: SECRET,
    db: mockDb,
    ...opts,
  });
  await app.ready();
  return app;
}

describe("githubWebhookPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.values.mockReturnThis();
    mockInsert.onConflictDoNothing.mockReturnThis();
    mockInsert.returning.mockResolvedValue([{ id: "delivery-row-1" }]);
  });

  afterEach(async () => {
    // no-op; each test builds its own app
  });

  describe("signature verification", () => {
    it("returns 401 when no signature header is sent", async () => {
      const app = await buildApp();
      const body = JSON.stringify({ action: "ping" });
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("returns 401 when signature uses the wrong secret", async () => {
      const app = await buildApp();
      const body = JSON.stringify({ action: "ping" });
      const wrongSig = makeSignature(body, "wrong-secret");
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": wrongSig,
        },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("returns 200 for a valid ping event", async () => {
      const app = await buildApp();
      const body = JSON.stringify({ action: "ping" });
      const sig = makeSignature(body);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "ping",
          "x-github-delivery": "delivery-1",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, ping: true });
      await app.close();
    });
  });

  describe("deduplication", () => {
    it("returns 202 duplicate=true when DB returns no row (already seen delivery)", async () => {
      mockInsert.returning.mockResolvedValue([]);
      const app = await buildApp();
      const body = JSON.stringify({ action: "push" });
      const sig = makeSignature(body);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "push",
          "x-github-delivery": "dup-delivery-1",
        },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true, duplicate: true });
      await app.close();
    });
  });

  describe("pull_request event", () => {
    it("calls processGithubPullRequestMerge and returns 200", async () => {
      mockProcessPr.mockResolvedValue({ processedIssues: 1 });
      const app = await buildApp();
      const body = JSON.stringify({
        action: "closed",
        pull_request: { merged: true, head: { ref: "hive/issue-42" } },
        repository: { full_name: "org/repo" },
      });
      const sig = makeSignature(body);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "pull_request",
          "x-github-delivery": "pr-delivery-1",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, processedIssues: 1 });
      expect(mockProcessPr).toHaveBeenCalledOnce();
      await app.close();
    });

    it("returns 202 ignored for unknown event types", async () => {
      const app = await buildApp();
      const body = JSON.stringify({ action: "labeled" });
      const sig = makeSignature(body);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-github-event": "issues",
          "x-github-delivery": "issues-delivery-1",
        },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true, ignored: true });
      await app.close();
    });
  });

  describe("plugin disabled", () => {
    it("does not register the route when enabled=false", async () => {
      const app = await buildApp({ enabled: false });
      const body = JSON.stringify({});
      const sig = makeSignature(body);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${COMPANY}/integrations/github/webhook`,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
        },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
