import { describe, expect, it } from "vitest";
import { encodeValueToToon } from "./toon-encode.js";

describe("encodeValueToToon", () => {
  it("encodes shallow object with sorted keys", () => {
    const s = encodeValueToToon({ b: 2, a: "x" });
    expect(s).toContain("a:");
    expect(s).toContain("b:");
    expect(s.indexOf("a:")).toBeLessThan(s.indexOf("b:"));
  });
});
