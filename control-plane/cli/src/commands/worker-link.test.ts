import { describe, expect, it } from "vitest";
import { normalizeControlPlaneHttpUrl } from "./worker-link.js";

describe("normalizeControlPlaneHttpUrl", () => {
  it("strips trailing slashes and /api suffix", () => {
    expect(normalizeControlPlaneHttpUrl("http://localhost:3100/api")).toBe("http://localhost:3100");
    expect(normalizeControlPlaneHttpUrl("http://localhost:3100/api/")).toBe("http://localhost:3100");
    expect(normalizeControlPlaneHttpUrl("  https://board.example/  ")).toBe("https://board.example");
  });
});
