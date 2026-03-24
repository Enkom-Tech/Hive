import { describe, expect, it } from "vitest";
import { ensureCspNonceOnScriptOpeningTags } from "../middleware/csp-nonce.js";

describe("ensureCspNonceOnScriptOpeningTags", () => {
  it("adds nonce to script tags that lack it", () => {
    const nonce = "abc123";
    const input = `<head><script type="module">x</script><script src="/a.js"></script></head>`;
    const out = ensureCspNonceOnScriptOpeningTags(input, nonce);
    expect(out).toContain(`<script nonce="${nonce}" type="module">`);
    expect(out).toContain(`<script nonce="${nonce}" src="/a.js">`);
  });

  it("does not duplicate nonce", () => {
    const nonce = "abc123";
    const input = `<script nonce="${nonce}" type="module">ok</script>`;
    expect(ensureCspNonceOnScriptOpeningTags(input, nonce)).toBe(input);
  });

  it("is a no-op when nonce is empty", () => {
    const input = `<script>inline</script>`;
    expect(ensureCspNonceOnScriptOpeningTags(input, "")).toBe(input);
  });
});
