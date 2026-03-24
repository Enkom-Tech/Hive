import { describe, expect, it, vi } from "vitest";
import {
  canonicalize,
  computeCanonicalKey,
  createOrFoldIntent,
  insertIntentLink,
  type IntentInput,
} from "../services/intent-folding.js";
import type { Db } from "@hive/db";

describe("canonicalize", () => {
  it("lowercases and collapses whitespace", () => {
    expect(canonicalize("  Hello   World  ")).toBe("hello world");
    expect(canonicalize("HELLO")).toBe("hello");
  });

  it("strips HTML tags", () => {
    expect(canonicalize("<p>foo</p> bar")).toBe("foo bar");
    expect(canonicalize("a <b>bold</b> word")).toBe("a bold word");
  });

  it("is deterministic: same input always yields same output", () => {
    const input = "  Fix the <em>login</em> button  ";
    expect(canonicalize(input)).toBe(canonicalize(input));
    expect(canonicalize(input)).toBe("fix the login button");
  });

  it("removes noise tokens when option enabled", () => {
    const input = "add a new feature for the dashboard";
    expect(canonicalize(input, { removeNoiseTokens: true })).toBe("add new feature dashboard");
  });

  it("returns empty string for empty or whitespace-only input", () => {
    expect(canonicalize("")).toBe("");
    expect(canonicalize("   ")).toBe("");
    expect(canonicalize("\n\t")).toBe("");
  });
});

describe("computeCanonicalKey", () => {
  it("is deterministic: same inputs yield same key", () => {
    const key1 = computeCanonicalKey("company-1", "create_issue", "fix login");
    const key2 = computeCanonicalKey("company-1", "create_issue", "fix login");
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different company yields different key", () => {
    const key1 = computeCanonicalKey("company-1", "create_issue", "fix login");
    const key2 = computeCanonicalKey("company-2", "create_issue", "fix login");
    expect(key1).not.toBe(key2);
  });

  it("different intent type yields different key", () => {
    const key1 = computeCanonicalKey("company-1", "create_issue", "fix login");
    const key2 = computeCanonicalKey("company-1", "update_goal", "fix login");
    expect(key1).not.toBe(key2);
  });

  it("different normalized text yields different key", () => {
    const key1 = computeCanonicalKey("company-1", "create_issue", "fix login");
    const key2 = computeCanonicalKey("company-1", "create_issue", "fix signup");
    expect(key1).not.toBe(key2);
  });

  it("truncates long text for hashing", () => {
    const long = "a".repeat(3000);
    const key = computeCanonicalKey("c", "create_issue", long);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("createOrFoldIntent", () => {
  const companyId = "550e8400-e29b-41d4-a716-446655440000";
  const input: IntentInput = {
    companyId,
    rawText: "Fix the login button",
    source: "board",
    intentType: "create_issue",
  };

  it("inserts new intent when none exists and returns folded: false", async () => {
    const insertedId = "intent-new-1";
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: vi.fn((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([]))),
            }),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: insertedId }]),
        }),
      }),
    } as unknown as Db;

    const result = await createOrFoldIntent(tx, input);

    expect(result.folded).toBe(false);
    expect(result.intentId).toBe(insertedId);
    expect(result.canonicalKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns existing intent when open match exists and folded: true", async () => {
    const existingId = "intent-existing-1";
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: vi.fn((cb: (rows: unknown[]) => unknown) =>
                Promise.resolve(cb([{ id: existingId }])),
              ),
            }),
          }),
        }),
      }),
      insert: vi.fn(),
    } as unknown as Db;

    const result = await createOrFoldIntent(tx, input);

    expect(result.folded).toBe(true);
    expect(result.intentId).toBe(existingId);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("insertIntentLink", () => {
  it("calls insert with correct shape", async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: insertValues,
      }),
    } as unknown as Db;

    await insertIntentLink(tx, {
      intentId: "intent-1",
      companyId: "company-1",
      entityType: "issue",
      entityId: "issue-1",
      linkType: "primary",
    });

    expect(insertValues).toHaveBeenCalledWith({
      intentId: "intent-1",
      companyId: "company-1",
      entityType: "issue",
      entityId: "issue-1",
      linkType: "primary",
    });
  });
});
