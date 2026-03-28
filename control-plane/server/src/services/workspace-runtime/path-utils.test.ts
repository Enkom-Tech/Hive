import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePathUnderRoot,
  isAbsolutePath,
  resolveConfiguredPath,
  sanitizeBranchName,
} from "./path-utils.js";

describe("sanitizeBranchName", () => {
  it("replaces invalid characters and trims length", () => {
    expect(sanitizeBranchName("  feature/foo bar!!!  ")).toBe("feature/foo-bar");
  });

  it("falls back when empty after sanitize", () => {
    expect(sanitizeBranchName("@@@")).toBe("hive-work");
  });
});

describe("isAbsolutePath", () => {
  it("detects absolute and tilde paths", () => {
    expect(isAbsolutePath("/tmp/x")).toBe(true);
    expect(isAbsolutePath("~/x")).toBe(true);
    expect(isAbsolutePath("relative")).toBe(false);
  });
});

describe("resolveConfiguredPath", () => {
  it("resolves relative paths against baseDir", () => {
    const base = "/project";
    expect(resolveConfiguredPath("sub/dir", base)).toBe(path.resolve(base, "sub/dir"));
  });
});

describe("ensurePathUnderRoot", () => {
  const root = path.resolve("/repo");

  it("allows exact root", () => {
    expect(() => ensurePathUnderRoot(root, root, "x")).not.toThrow();
  });

  it("allows nested path", () => {
    const nested = path.join(root, "a", "b");
    expect(() => ensurePathUnderRoot(nested, root, "x")).not.toThrow();
  });

  it("rejects escape via ..", () => {
    const outside = path.join(root, "..", "etc");
    expect(() => ensurePathUnderRoot(outside, root, "workspace")).toThrow(/outside repository root/);
  });
});
