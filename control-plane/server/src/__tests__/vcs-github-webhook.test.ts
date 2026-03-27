import { describe, expect, it } from "vitest";
import { verifyGithubWebhookSignature } from "../services/vcs-github-webhook.js";
import { createHmac } from "node:crypto";

describe("verifyGithubWebhookSignature", () => {
  it("accepts valid sha256", () => {
    const body = Buffer.from('{"action":"ping"}');
    const secret = "testsecret";
    const sig =
      "sha256=" +
      createHmac("sha256", secret)
        .update(body)
        .digest("hex");
    expect(verifyGithubWebhookSignature(body, secret, sig)).toBe(true);
  });

  it("rejects bad secret", () => {
    const body = Buffer.from("{}");
    const sig = "sha256=" + createHmac("sha256", "a").update(body).digest("hex");
    expect(verifyGithubWebhookSignature(body, "b", sig)).toBe(false);
  });
});
