import { describe, expect, it } from "vitest";
import { assigneeAllowedByScopeParentMap } from "./assign-scope.js";

describe("assigneeAllowedByScopeParentMap", () => {
  it("allows the root agent", () => {
    const m = new Map<string, string | null>([
      ["ceo", null],
      ["mgr", "ceo"],
      ["ic", "mgr"],
    ]);
    expect(assigneeAllowedByScopeParentMap("ceo", "ceo", [], m)).toBe(true);
  });

  it("allows descendants of root", () => {
    const m = new Map<string, string | null>([
      ["ceo", null],
      ["mgr", "ceo"],
      ["ic", "mgr"],
    ]);
    expect(assigneeAllowedByScopeParentMap("ic", "ceo", [], m)).toBe(true);
    expect(assigneeAllowedByScopeParentMap("mgr", "ceo", [], m)).toBe(true);
  });

  it("rejects agents outside subtree", () => {
    const m = new Map<string, string | null>([
      ["ceo", null],
      ["other", null],
      ["ic", "ceo"],
    ]);
    expect(assigneeAllowedByScopeParentMap("other", "ceo", [], m)).toBe(false);
  });

  it("rejects excluded ids even if in subtree", () => {
    const m = new Map<string, string | null>([
      ["ceo", null],
      ["bad", "ceo"],
    ]);
    expect(assigneeAllowedByScopeParentMap("bad", "ceo", ["bad"], m)).toBe(false);
  });

  it("rejects cycles", () => {
    const m = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(assigneeAllowedByScopeParentMap("a", "ceo", [], m)).toBe(false);
  });
});
