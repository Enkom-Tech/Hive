import { describe, expect, it } from "vitest";
import { signWorkerContainerPolicyPayload, tryBuildWorkerContainerPolicyMessage } from "../worker-container-policy.js";

/** Vectors aligned with infra/worker/internal/policyoverlay/overlay_test.go */
describe("worker-container-policy", () => {
  it("signWorkerContainerPolicyPayload matches Go overlay test vector", () => {
    const sig = signWorkerContainerPolicyPayload("s3cret", "1", "ghcr.io/org/", "2099-01-01");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const expected = signWorkerContainerPolicyPayload("s3cret", "1", "ghcr.io/org/", "2099-01-01");
    expect(sig).toBe(expected);
  });

  it("tryBuildWorkerContainerPolicyMessage returns null without secret or allowlist", () => {
    expect(tryBuildWorkerContainerPolicyMessage(undefined)).toBeNull();
    expect(
      tryBuildWorkerContainerPolicyMessage({
        secret: "",
        allowlistCsv: "x",
        version: "1",
        expiresAt: "",
      }),
    ).toBeNull();
    expect(
      tryBuildWorkerContainerPolicyMessage({
        secret: "s",
        allowlistCsv: "  ",
        version: "1",
        expiresAt: "",
      }),
    ).toBeNull();
  });

  it("tryBuildWorkerContainerPolicyMessage builds typed frame", () => {
    const msg = tryBuildWorkerContainerPolicyMessage({
      secret: "s3cret",
      allowlistCsv: "ghcr.io/org/",
      version: "1",
      expiresAt: "2099-01-01",
    });
    expect(msg).toEqual({
      type: "worker_container_policy",
      version: "1",
      allowlistCsv: "ghcr.io/org/",
      expiresAt: "2099-01-01",
      signature: signWorkerContainerPolicyPayload("s3cret", "1", "ghcr.io/org/", "2099-01-01"),
    });
  });
});
