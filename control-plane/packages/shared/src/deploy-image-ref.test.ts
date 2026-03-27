import { describe, expect, it } from "vitest";
import { isDigestPinnedImageRef } from "./deploy-image-ref.js";

describe("isDigestPinnedImageRef", () => {
  const validDigest =
    "a".repeat(64);
  const okRef = `registry.example/project/image@sha256:${validDigest}`;

  it("accepts reference ending with @sha256:64-hex", () => {
    expect(isDigestPinnedImageRef(okRef)).toBe(true);
    expect(isDigestPinnedImageRef(`  ${okRef}  `)).toBe(true);
  });

  it("rejects tag-only and short digest", () => {
    expect(isDigestPinnedImageRef("docker.io/library/nginx:latest")).toBe(false);
    expect(isDigestPinnedImageRef(`registry.io/x@sha256:${"b".repeat(63)}`)).toBe(false);
    expect(isDigestPinnedImageRef("")).toBe(false);
  });
});
