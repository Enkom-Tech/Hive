import { describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { costService } from "../services/costs.js";

const companyId = "550e8400-e29b-41d4-a716-446655440000";

function createMockDbWithResponses(responses: unknown[][]): Db {
  let callIndex = 0;
  const chain = {
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnValue({
      then: (cb: (rows: unknown[]) => unknown) => {
        const rows = responses[callIndex] ?? [];
        callIndex += 1;
        return Promise.resolve(cb(rows));
      },
    }),
  };
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(chain),
      }),
    }),
  } as unknown as Db;
}

describe("costService.series", () => {
  it("returns empty array when no data", async () => {
    const db = createMockDbWithResponses([[]]);
    const costs = costService(db);
    const result = await costs.series(companyId, undefined, "day");
    expect(result).toEqual([]);
  });

  it("returns time-series points with date, costCents, tokens", async () => {
    const seriesRows = [
      { date: "2026-03-01", costCents: 100, inputTokens: 1000, outputTokens: 500 },
      { date: "2026-03-02", costCents: 200, inputTokens: 2000, outputTokens: 1000 },
    ];
    const db = createMockDbWithResponses([seriesRows]);
    const costs = costService(db);
    const result = await costs.series(companyId, undefined, "day");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ date: "2026-03-01", costCents: 100, inputTokens: 1000, outputTokens: 500 });
    expect(result[1]).toEqual({ date: "2026-03-02", costCents: 200, inputTokens: 2000, outputTokens: 1000 });
  });

  it("accepts week bucket", async () => {
    const seriesRows = [{ date: "2026-03-03", costCents: 300, inputTokens: 3000, outputTokens: 1500 }];
    const db = createMockDbWithResponses([seriesRows]);
    const costs = costService(db);
    const result = await costs.series(companyId, { from: new Date("2026-03-01"), to: new Date("2026-03-10") }, "week");
    expect(result).toHaveLength(1);
    expect(result[0].costCents).toBe(300);
  });
});

describe("costService.byModel", () => {
  it("returns empty array when no data", async () => {
    const db = createMockDbWithResponses([[]]);
    const costs = costService(db);
    const result = await costs.byModel(companyId);
    expect(result).toEqual([]);
  });

  it("returns by-model rows with model, provider, costCents, tokens", async () => {
    const byModelRows = [
      { model: "claude-3-5-sonnet", provider: "anthropic", costCents: 500, inputTokens: 5000, outputTokens: 2000 },
      { model: "gpt-4o", provider: "openai", costCents: 300, inputTokens: 3000, outputTokens: 1000 },
    ];
    const db = createMockDbWithResponses([byModelRows]);
    const costs = costService(db);
    const result = await costs.byModel(companyId);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ model: "claude-3-5-sonnet", provider: "anthropic", costCents: 500, inputTokens: 5000, outputTokens: 2000 });
    expect(result[1]).toEqual({ model: "gpt-4o", provider: "openai", costCents: 300, inputTokens: 3000, outputTokens: 1000 });
  });
});
