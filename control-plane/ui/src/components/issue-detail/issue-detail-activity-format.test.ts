import { describe, expect, it } from "vitest";
import { buildIssueCostSummary, formatActivityAction } from "./issue-detail-activity-format";

describe("formatActivityAction", () => {
  it("describes status transition for issue.updated", () => {
    const text = formatActivityAction("issue.updated", {
      status: "done",
      _previous: { status: "in_progress" },
    });
    expect(text).toContain("status");
    expect(text.toLowerCase()).toContain("done");
  });
});

describe("buildIssueCostSummary", () => {
  it("aggregates token and cost fields from runs", () => {
    const summary = buildIssueCostSummary([
      {
        usageJson: { input_tokens: 10, output_tokens: 20, cost_usd: 0.01 },
        resultJson: null,
      },
    ]);
    expect(summary.totalTokens).toBe(30);
    expect(summary.cost).toBeCloseTo(0.01, 5);
    expect(summary.hasCost).toBe(true);
    expect(summary.hasTokens).toBe(true);
  });
});
