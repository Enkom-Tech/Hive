import { describe, expect, it } from "vitest";
import { pickNextCircularId } from "./placement-pool.js";

describe("pickNextCircularId", () => {
  it("returns null for empty list", () => {
    expect(pickNextCircularId([], "a")).toBeNull();
  });

  it("picks first when current is null", () => {
    expect(pickNextCircularId(["b", "c"], null)).toBe("b");
  });

  it("advances circularly in sorted order", () => {
    expect(pickNextCircularId(["a", "b", "c"], "a")).toBe("b");
    expect(pickNextCircularId(["a", "b", "c"], "b")).toBe("c");
    expect(pickNextCircularId(["a", "b", "c"], "c")).toBe("a");
  });

  it("when current is not eligible, picks first eligible", () => {
    expect(pickNextCircularId(["b", "c"], "gone")).toBe("b");
  });
});
