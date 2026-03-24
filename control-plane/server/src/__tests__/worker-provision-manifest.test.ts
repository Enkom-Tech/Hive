import { describe, expect, it } from "vitest";
import {
  parseWorkerProvisionManifest,
  resolveEffectiveWorkerRuntimeManifest,
} from "../services/worker-provision-manifest.js";

describe("parseWorkerProvisionManifest", () => {
  it("parses valid manifest", () => {
    const m = parseWorkerProvisionManifest(
      JSON.stringify({
        version: "v1",
        adapters: { codex: { url: "https://example.com/c.tar.gz", sha256: "abc" } },
      }),
    );
    expect(m.version).toBe("v1");
    expect(m.adapters.codex?.url).toBe("https://example.com/c.tar.gz");
    expect(m.adapters.codex?.sha256).toBe("abc");
  });

  it("defaults version when omitted", () => {
    const m = parseWorkerProvisionManifest(
      JSON.stringify({ adapters: { x: { url: "https://x.test/bin" } } }),
    );
    expect(m.version).toBe("v1");
  });

  it("rejects non-https url", () => {
    expect(() =>
      parseWorkerProvisionManifest(
        JSON.stringify({ adapters: { x: { url: "http://evil.com/a" } } }),
      ),
    ).toThrow("https");
  });

  it("rejects empty adapters object shape", () => {
    expect(() => parseWorkerProvisionManifest(JSON.stringify({ adapters: "nope" }))).toThrow();
  });

  it("parses optional hook lists", () => {
    const m = parseWorkerProvisionManifest(
      JSON.stringify({
        adapters: { x: { url: "https://example.com/bin" } },
        aptPackages: ["curl", "jq"],
        npmGlobal: ["typescript@5"],
        dockerImages: ["docker.io/library/alpine:3.20"],
      }),
    );
    expect(m.aptPackages).toEqual(["curl", "jq"]);
    expect(m.npmGlobal).toEqual(["typescript@5"]);
    expect(m.dockerImages).toEqual(["docker.io/library/alpine:3.20"]);
  });

  it("rejects invalid hook entries", () => {
    expect(() =>
      parseWorkerProvisionManifest(
        JSON.stringify({
          adapters: { x: { url: "https://example.com/bin" } },
          aptPackages: ["bad name"],
        }),
      ),
    ).toThrow("aptPackages");
  });
});

describe("resolveEffectiveWorkerRuntimeManifest", () => {
  it("prefers company JSON over global inline", async () => {
    const m = await resolveEffectiveWorkerRuntimeManifest({
      companyManifestJson: JSON.stringify({
        version: "v2",
        adapters: { a: { url: "https://company.example/bin" } },
      }),
      globalInlineJson: JSON.stringify({
        version: "v1",
        adapters: { b: { url: "https://global.example/bin" } },
      }),
    });
    expect(m?.version).toBe("v2");
    expect(m?.adapters.a?.url).toContain("company.example");
  });
});
