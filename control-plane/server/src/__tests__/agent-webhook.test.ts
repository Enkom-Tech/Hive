import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK } from "@hive/shared";
import {
  AgentWebhookCircuitManager,
  isAllowedWebhookUrl,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_JITTER_FRACTION,
  WEBHOOK_RETRY_DELAYS_MS,
  WORKABLE_STATUSES_FOR_WEBHOOK,
  WEBHOOK_VERSION,
} from "../services/agent-webhook.js";

const shortRetryConfig = {
  delaysMs: WEBHOOK_RETRY_DELAYS_MS,
  jitterFraction: WEBHOOK_JITTER_FRACTION,
};

describe("agent-webhook", () => {
  let webhookManager: AgentWebhookCircuitManager;

  describe("verifyWebhookSignature", () => {
    it("returns true when signature matches", () => {
      const body = '{"event":"work_available"}';
      const secret = "secret";
      const sig = signWebhookPayload(body, secret);
      expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    });
    it("returns false when signature does not match", () => {
      const body = '{"event":"work_available"}';
      expect(verifyWebhookSignature(body, "0".repeat(64), "secret")).toBe(false);
    });
    it("returns false when lengths differ (constant-time safe)", () => {
      const body = '{"event":"work_available"}';
      const sig = signWebhookPayload(body, "secret");
      expect(verifyWebhookSignature(body, sig.slice(0, 32), "secret")).toBe(false);
    });
  });

  describe("signWebhookPayload", () => {
    it("produces hex-encoded HMAC-SHA256 of body", () => {
      const body = '{"event":"work_available","issueId":"i1"}';
      const secret = "my-secret";
      const sig = signWebhookPayload(body, secret);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
      expect(signWebhookPayload(body, secret)).toBe(sig);
      expect(signWebhookPayload(body, "other")).not.toBe(sig);
      expect(signWebhookPayload(body + "x", secret)).not.toBe(sig);
    });
  });

  describe("isAllowedWebhookUrl", () => {
    it("accepts https URLs", () => {
      expect(isAllowedWebhookUrl("https://example.com/webhook")).toBe(true);
      expect(isAllowedWebhookUrl("https://localhost:9999/cb")).toBe(true);
    });

    it("rejects invalid URLs", () => {
      expect(isAllowedWebhookUrl("not-a-url")).toBe(false);
      expect(isAllowedWebhookUrl("")).toBe(false);
    });

    it("rejects non-http(s) protocols", () => {
      expect(isAllowedWebhookUrl("file:///tmp/x")).toBe(false);
    });

    it("in production rejects http", () => {
      const orig = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        expect(isAllowedWebhookUrl("http://example.com/webhook")).toBe(false);
        expect(isAllowedWebhookUrl("https://example.com/webhook")).toBe(true);
      } finally {
        process.env.NODE_ENV = orig;
      }
    });
  });

  describe("deliverWorkAvailable", () => {
    const agentId = "agent-1";
    const companyId = "company-1";
    const issueId = "issue-1";

    function mockDb(runtimeConfig: Record<string, unknown>): Db {
      return {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: agentId,
                    companyId,
                    runtimeConfig,
                  },
                ]),
            }),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as Db;
    }

    beforeEach(() => {
      webhookManager = new AgentWebhookCircuitManager();
      vi.stubGlobal("fetch", vi.fn());
      webhookManager.resetForTests();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns without sending when agent has no webhookUrl", async () => {
      await webhookManager.deliverWorkAvailable(agentId, companyId, issueId, mockDb({}));
      expect(fetch).not.toHaveBeenCalled();
    });

    it("returns without sending when agent has webhookUrl but no webhookSecret", async () => {
      await webhookManager.deliverWorkAvailable(agentId, companyId, issueId, mockDb({ webhookUrl: "https://example.com/hook" }));
      expect(fetch).not.toHaveBeenCalled();
    });

    it("sends POST with correct payload and signature when webhookUrl and secret set", async () => {
      const webhookUrl = "https://example.com/hook";
      const secret = "my-secret";
      (vi.mocked(fetch) as any).mockResolvedValue({ ok: true });

      await webhookManager.deliverWorkAvailable(agentId, companyId, issueId, mockDb({ webhookUrl, webhookSecret: secret }));

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (fetch as any).mock.calls[0];
      expect(url).toBe(webhookUrl);
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers["X-Hive-Webhook-Version"]).toBe(String(WEBHOOK_VERSION));
      const body = opts.body;
      const payload = JSON.parse(body);
      expect(payload).toMatchObject({
        event: "work_available",
        issueId,
        companyId,
        agentId,
        version: WEBHOOK_VERSION,
      });
      expect(typeof payload.timestamp).toBe("string");
      const expectedSig = signWebhookPayload(body, secret);
      expect(opts.headers["X-Hive-Signature"]).toBe(expectedSig);
    });

    describe("retry policy", () => {
      it("retries on 5xx up to max attempts", async () => {
        vi.useFakeTimers();
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: false, status: 500 });
        const db = mockDb({ webhookUrl: "https://example.com/hook", webhookSecret: "secret" });

        let err: unknown;
        const p = webhookManager.deliverWorkAvailable(agentId, companyId, issueId, db, shortRetryConfig).catch((e) => {
          err = e;
        });
        await vi.advanceTimersByTimeAsync(10000);
        await p;
        vi.useRealTimers();

        expect(err).toBeDefined();
        expect((err as Error).message).toBe("HTTP 500");
        expect(fetch).toHaveBeenCalledTimes(4);
      }, 15000);

      it("does not retry on 4xx (e.g. 400)", async () => {
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: false, status: 400 });
        const db = mockDb({ webhookUrl: "https://example.com/hook", webhookSecret: "secret" });

        await expect(webhookManager.deliverWorkAvailable(agentId, companyId, issueId, db)).rejects.toThrow("HTTP 400");
        expect(fetch).toHaveBeenCalledTimes(1);
      });

      it("succeeds on second attempt and stops retrying", async () => {
        vi.useFakeTimers();
        (vi.mocked(fetch) as any)
          .mockResolvedValueOnce({ ok: false, status: 503 })
          .mockResolvedValueOnce({ ok: true });
        const db = mockDb({ webhookUrl: "https://example.com/hook", webhookSecret: "secret" });

        const p = webhookManager.deliverWorkAvailable(agentId, companyId, issueId, db, shortRetryConfig);
        await vi.advanceTimersByTimeAsync(2000);
        await p;
        vi.useRealTimers();

        expect(fetch).toHaveBeenCalledTimes(2);
      });
    });

    describe("circuit breaker", () => {
      const circuitAgentId = "circuit-agent-1";

      function mockDbCircuit(config: Record<string, unknown>): Db {
        return {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      id: circuitAgentId,
                      companyId: "company-1",
                      runtimeConfig: config,
                    },
                  ]),
              }),
            }),
          }),
          insert: () => ({ values: () => Promise.resolve() }),
        } as unknown as Db;
      }

      it("skips delivery when circuit is open", async () => {
        webhookManager.resetForTests();
        vi.useFakeTimers();
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: false, status: 500 });
        const db = mockDbCircuit({
          webhookUrl: "https://example.com/hook",
          webhookSecret: "secret",
        });

        let err1: unknown;
        const p1 = webhookManager
          .deliverWorkAvailable(circuitAgentId, "company-1", "issue-1", db, shortRetryConfig)
          .catch((e) => {
          err1 = e;
          });
        await vi.advanceTimersByTimeAsync(10000);
        await p1;
        expect(err1).toBeDefined();
        expect((err1 as Error).message).toBe("HTTP 500");
        expect(fetch).toHaveBeenCalledTimes(4);

        let err2: unknown;
        const p2 = webhookManager
          .deliverWorkAvailable(circuitAgentId, "company-1", "issue-2", db, shortRetryConfig)
          .catch((e) => {
          err2 = e;
          });
        await vi.advanceTimersByTimeAsync(10000);
        await p2;
        expect(err2).toBeDefined();
        expect(fetch).toHaveBeenCalledTimes(8);

        await webhookManager.deliverWorkAvailable(circuitAgentId, "company-1", "issue-3", db, shortRetryConfig);
        expect(fetch).toHaveBeenCalledTimes(8);
        vi.useRealTimers();
      }, 15000);

      it("attempts delivery again after reset", async () => {
        webhookManager.resetForTests();
        vi.useFakeTimers();
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: false, status: 500 });
        const db = mockDbCircuit({
          webhookUrl: "https://example.com/hook",
          webhookSecret: "secret",
        });

        let err1: unknown;
        const p1 = webhookManager.deliverWorkAvailable(
          circuitAgentId,
          "company-1",
          "issue-1",
          db,
          shortRetryConfig,
        ).catch((e) => {
          err1 = e;
        });
        await vi.advanceTimersByTimeAsync(10000);
        await p1;
        let err2: unknown;
        const p2 = webhookManager.deliverWorkAvailable(
          circuitAgentId,
          "company-1",
          "issue-2",
          db,
          shortRetryConfig,
        ).catch((e) => {
          err2 = e;
        });
        await vi.advanceTimersByTimeAsync(10000);
        await p2;
        expect(err1).toBeDefined();
        expect(err2).toBeDefined();
        expect(fetch).toHaveBeenCalledTimes(8);
        webhookManager.resetForTests();
        vi.useRealTimers();
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: true });
        await webhookManager.deliverWorkAvailable(circuitAgentId, "company-1", "issue-3", db, shortRetryConfig);
        expect(fetch).toHaveBeenCalledTimes(9);
      });

      it("allows one probe after cooldown then closes on success", async () => {
        webhookManager.resetForTests();
        vi.useFakeTimers();
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: false, status: 500 });
        const db = mockDbCircuit({
          webhookUrl: "https://example.com/hook",
          webhookSecret: "secret",
        });

        let err1: unknown;
        const p1 = webhookManager.deliverWorkAvailable(
          circuitAgentId,
          "company-1",
          "issue-1",
          db,
          shortRetryConfig,
        ).catch((e) => {
          err1 = e;
        });
        await vi.advanceTimersByTimeAsync(10000);
        await p1;
        let err2: unknown;
        const p2 = webhookManager.deliverWorkAvailable(
          circuitAgentId,
          "company-1",
          "issue-2",
          db,
          shortRetryConfig,
        ).catch((e) => {
          err2 = e;
        });
        await vi.advanceTimersByTimeAsync(10000);
        await p2;
        expect(err1).toBeDefined();
        expect(err2).toBeDefined();
        expect(fetch).toHaveBeenCalledTimes(8);

        await webhookManager.deliverWorkAvailable(circuitAgentId, "company-1", "issue-3", db, shortRetryConfig);
        expect(fetch).toHaveBeenCalledTimes(8);

        vi.advanceTimersByTime(61000);
        (vi.mocked(fetch) as any).mockResolvedValue({ ok: true });
        await webhookManager.deliverWorkAvailable(circuitAgentId, "company-1", "issue-4", db, shortRetryConfig);
        expect(fetch).toHaveBeenCalledTimes(9);
        vi.useRealTimers();
      });
    });
  });

  describe("WORKABLE_STATUSES_FOR_WEBHOOK", () => {
    it("equals shared ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK", () => {
      expect([...WORKABLE_STATUSES_FOR_WEBHOOK].sort()).toEqual([...ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK].sort());
    });
  });
});
