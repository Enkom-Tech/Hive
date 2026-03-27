import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  adaptReplayedWorkerApiBody,
  buildWorkerApiSuccessResponse,
  wantsAgentPayloadToon,
  workerApiSuccessJsonBody,
} from "./worker-api-payload.js";

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as Request;
}

describe("wantsAgentPayloadToon", () => {
  const prev = process.env.HIVE_AGENT_PAYLOAD_FORMAT;

  it("is true when X-Hive-Agent-Payload-Format is toon", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    expect(wantsAgentPayloadToon(mockReq({ "x-hive-agent-payload-format": "toon" }))).toBe(true);
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });

  it("is true when Accept includes application/x-hive-toon", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    expect(wantsAgentPayloadToon(mockReq({ accept: "application/json, application/x-hive-toon" }))).toBe(true);
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });

  it("is false without env or headers", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    expect(wantsAgentPayloadToon(mockReq({}))).toBe(false);
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });
});

describe("buildWorkerApiSuccessResponse", () => {
  const prev = process.env.HIVE_AGENT_PAYLOAD_FORMAT;

  it("returns JSON shape by default", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    const r = buildWorkerApiSuccessResponse(mockReq({}), { a: 1 });
    expect(r).toEqual({ ok: true, result: { a: 1 } });
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });

  it("returns format toon when negotiated", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    const r = buildWorkerApiSuccessResponse(mockReq({ "x-hive-agent-payload-format": "toon" }), { b: 2 });
    expect(r.ok).toBe(true);
    if ("format" in r) {
      expect(r.format).toBe("toon");
      expect(typeof r.result).toBe("string");
      expect(r.result).toContain("b:");
    }
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });
});

describe("adaptReplayedWorkerApiBody", () => {
  const prev = process.env.HIVE_AGENT_PAYLOAD_FORMAT;

  it("passes through when not requesting toon", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    const body = workerApiSuccessJsonBody({ issue: { id: "x" } });
    expect(adaptReplayedWorkerApiBody(mockReq({}), body)).toBe(body);
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });

  it("re-encodes cached JSON to toon when header set", () => {
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = "";
    const body = workerApiSuccessJsonBody({ costEventId: "ce-1" });
    const out = adaptReplayedWorkerApiBody(mockReq({ "x-hive-agent-payload-format": "toon" }), body) as {
      ok: boolean;
      format: string;
      result: string;
    };
    expect(out.format).toBe("toon");
    expect(out.result).toContain("costEventId:");
    process.env.HIVE_AGENT_PAYLOAD_FORMAT = prev;
  });
});
