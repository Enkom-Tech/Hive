import { describe, expect, it } from "vitest";
import { createWorkerIdentitySlotSchema } from "@hive/shared";

describe("createWorkerIdentitySlotSchema", () => {
  it("accepts slug profile keys", () => {
    const r = createWorkerIdentitySlotSchema.safeParse({
      profileKey: "pool-engineer",
      displayNamePrefix: "Engineer",
      desiredCount: 2,
    });
    expect(r.success).toBe(true);
  });

  it("rejects uppercase profile keys", () => {
    const r = createWorkerIdentitySlotSchema.safeParse({
      profileKey: "POOL",
      displayNamePrefix: "E",
      desiredCount: 1,
    });
    expect(r.success).toBe(false);
  });
});
