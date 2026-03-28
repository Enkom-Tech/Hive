import { describe, expect, it } from "vitest";
import { getContrastTextColor } from "./new-issue-draft";

describe("getContrastTextColor", () => {
  it("returns dark text on light backgrounds", () => {
    expect(getContrastTextColor("#ffffff")).toBe("#000000");
  });

  it("returns light text on dark backgrounds", () => {
    expect(getContrastTextColor("#000000")).toBe("#ffffff");
  });
});
