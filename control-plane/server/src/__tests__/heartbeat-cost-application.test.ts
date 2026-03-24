import { describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createCostApplication } from "../services/heartbeat/cost-application.js";

const mockCreateEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/costs.js", () => ({
  costService: vi.fn(() => ({ createEvent: mockCreateEvent })),
}));

describe("createCostApplication", () => {
  it("returns updateRuntimeState function", () => {
    const db = {} as Db;
    const app = createCostApplication({ db });
    expect(app).toHaveProperty("updateRuntimeState");
    expect(typeof app.updateRuntimeState).toBe("function");
  });

  it("updateRuntimeState calls costService.createEvent when costCents > 0", async () => {
    mockCreateEvent.mockClear();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            Promise.resolve([{ agentId: "a1", companyId: "c1", adapterType: "managed_worker" }]),
          ),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Promise.resolve()),
        }),
      }),
    } as unknown as Db;

    const app = createCostApplication({ db });
    const agent = { id: "a1", companyId: "c1", adapterType: "managed_worker" } as Parameters<
      typeof app.updateRuntimeState
    >[0];
    const run = { id: "r1", status: "succeeded", agentId: "a1", companyId: "c1" } as Parameters<
      typeof app.updateRuntimeState
    >[1];
    const result = {
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
      costUsd: 0.05,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };

    await app.updateRuntimeState(agent, run, result, { legacySessionId: "s1" });

    expect(mockCreateEvent).toHaveBeenCalledWith("c1", expect.objectContaining({
      agentId: "a1",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10,
      outputTokens: 20,
      costCents: 5,
    }));
  });
});
