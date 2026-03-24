import { describe, it, expect } from "vitest";
import { sendRunToWorker, sendCancelToWorker, isAgentWorkerConnected } from "./worker-link.js";

describe("worker-link", () => {
  describe("sendRunToWorker", () => {
    it("returns false when no worker is connected", () => {
      expect(sendRunToWorker("agent-1", { type: "run", runId: "run-1", context: {} })).toBe(false);
    });
  });

  describe("sendCancelToWorker", () => {
    it("returns false when no worker is connected", () => {
      expect(sendCancelToWorker("agent-1", "run-1")).toBe(false);
    });
  });

  describe("isAgentWorkerConnected", () => {
    it("returns false when no worker is connected", () => {
      expect(isAgentWorkerConnected("agent-1")).toBe(false);
    });
  });
});
