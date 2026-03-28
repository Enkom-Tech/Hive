import { describe, expect, it } from "vitest";
import { ensureMarkdownPath } from "./portability-validate.js";

describe("ensureMarkdownPath", () => {
  it("normalizes backslashes and keeps .md suffix", () => {
    expect(ensureMarkdownPath("manifests\\foo.md")).toBe("manifests/foo.md");
  });

  it("throws when path does not end with .md", () => {
    expect(() => ensureMarkdownPath("readme.txt")).toThrow(/\.md/);
  });
});
