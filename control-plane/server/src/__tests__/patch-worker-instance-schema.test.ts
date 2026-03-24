import { describe, expect, it } from "vitest";
import { patchWorkerInstanceSchema } from "@hive/shared";

describe("patchWorkerInstanceSchema", () => {
  it("accepts drainRequested", () => {
    expect(patchWorkerInstanceSchema.parse({ drainRequested: true })).toEqual({ drainRequested: true });
  });

  it("rejects empty body", () => {
    expect(() => patchWorkerInstanceSchema.parse({})).toThrow();
  });
});
