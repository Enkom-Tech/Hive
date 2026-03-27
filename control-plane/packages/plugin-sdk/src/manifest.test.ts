import { describe, expect, it } from "vitest";
import { parsePluginManifestJson, safeParsePluginManifestJson } from "./manifest.js";

describe("parsePluginManifestJson", () => {
  it("parses a minimal manifest", () => {
    const m = parsePluginManifestJson(
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        capabilities: ["rpc.ping"],
        tools: [{ name: "echo", description: "noop" }],
      }),
    );
    expect(m.name).toBe("demo");
    expect(m.tools?.[0]?.name).toBe("echo");
  });

  it("rejects unknown capabilities", () => {
    expect(() =>
      parsePluginManifestJson(
        JSON.stringify({ name: "x", version: "1", capabilities: ["evil.cap"] }),
      ),
    ).toThrow();
  });

  it("safe-parse fails on invalid JSON", () => {
    const r = safeParsePluginManifestJson("{");
    expect(r.success).toBe(false);
  });
});
