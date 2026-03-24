import { generateKeyPairSync, createPrivateKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatSignatureHeader,
  signProvisionManifestBody,
  stableStringifyProvisionManifest,
} from "../services/worker-manifest-signature.js";
import type { WorkerProvisionManifest } from "../services/worker-provision-manifest.js";

describe("worker manifest Ed25519 signing", () => {
  it("stable stringifies deterministically", () => {
    const a: WorkerProvisionManifest = {
      version: "v1",
      adapters: { z: { url: "https://a.com/b" }, a: { url: "https://x.com/y" } },
    };
    const b: WorkerProvisionManifest = {
      version: "v1",
      adapters: { a: { url: "https://x.com/y" }, z: { url: "https://a.com/b" } },
    };
    expect(stableStringifyProvisionManifest(a)).toBe(stableStringifyProvisionManifest(b));
  });

  it("signs and verifies with same bytes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const key = createPrivateKey(pem);
    const body = stableStringifyProvisionManifest({
      version: "v1",
      adapters: { c: { url: "https://example.com/x" } },
    });
    const sigBuf = signProvisionManifestBody(body, key);
    const hdr = formatSignatureHeader(sigBuf);
    expect(hdr.startsWith("v1-ed25519-")).toBe(true);
    const sig = Buffer.from(hdr.replace(/^v1-ed25519-/, ""), "base64");
    const ok = verify(null, Buffer.from(body, "utf8"), publicKey, sig);
    expect(ok).toBe(true);
  });
});
