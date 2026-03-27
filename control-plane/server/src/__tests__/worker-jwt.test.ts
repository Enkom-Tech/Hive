import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerJwt, verifyWorkerJwt } from "../auth/worker-jwt.js";

describe("worker-jwt", () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    prev.HIVE_WORKER_JWT_SECRET = process.env.HIVE_WORKER_JWT_SECRET;
    prev.HIVE_WORKER_JWT_ISSUER = process.env.HIVE_WORKER_JWT_ISSUER;
    prev.HIVE_WORKER_JWT_AUDIENCE = process.env.HIVE_WORKER_JWT_AUDIENCE;
    prev.HIVE_WORKER_JWT_TTL_SECONDS = process.env.HIVE_WORKER_JWT_TTL_SECONDS;
    process.env.HIVE_WORKER_JWT_SECRET = "test-worker-jwt-secret-min-32-chars-long!!";
    delete process.env.HIVE_WORKER_JWT_ISSUER;
    delete process.env.HIVE_WORKER_JWT_AUDIENCE;
    delete process.env.HIVE_WORKER_JWT_TTL_SECONDS;
  });

  afterEach(() => {
    for (const k of Object.keys(prev)) {
      const v = prev[k as keyof typeof prev];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("round-trips and verifies kind worker_instance", () => {
    const tok = createWorkerJwt("wi-1", "550e8400-e29b-41d4-a716-446655440000");
    expect(tok).toBeTruthy();
    const claims = verifyWorkerJwt(tok!);
    expect(claims?.sub).toBe("wi-1");
    expect(claims?.company_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(claims?.kind).toBe("worker_instance");
  });

  it("rejects tampered signature", () => {
    const tok = createWorkerJwt("wi-1", "550e8400-e29b-41d4-a716-446655440000")!;
    const parts = tok.split(".");
    const bad = `${parts[0]}.${parts[1]}.aaaa`;
    expect(verifyWorkerJwt(bad)).toBeNull();
  });

  it("rejects wrong issuer when HIVE_WORKER_JWT_ISSUER is set", () => {
    process.env.HIVE_WORKER_JWT_ISSUER = "expected-iss";
    const tok = createWorkerJwt("wi-1", "550e8400-e29b-41d4-a716-446655440000");
    expect(tok).toBeTruthy();
    process.env.HIVE_WORKER_JWT_ISSUER = "other-iss";
    expect(verifyWorkerJwt(tok!)).toBeNull();
  });

  it("rejects wrong audience when HIVE_WORKER_JWT_AUDIENCE is set", () => {
    process.env.HIVE_WORKER_JWT_AUDIENCE = "expected-aud";
    const tok = createWorkerJwt("wi-1", "550e8400-e29b-41d4-a716-446655440000");
    expect(tok).toBeTruthy();
    process.env.HIVE_WORKER_JWT_AUDIENCE = "other-aud";
    expect(verifyWorkerJwt(tok!)).toBeNull();
  });

  it("rejects expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    process.env.HIVE_WORKER_JWT_TTL_SECONDS = "60";
    const tok = createWorkerJwt("wi-1", "550e8400-e29b-41d4-a716-446655440000");
    expect(tok).toBeTruthy();
    expect(verifyWorkerJwt(tok!)).toBeTruthy();
    vi.advanceTimersByTime(120_000);
    expect(verifyWorkerJwt(tok!)).toBeNull();
    vi.useRealTimers();
  });
});
