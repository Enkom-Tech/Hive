import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import type { Response } from "express";
import type { WorkerProvisionManifest } from "./worker-provision-manifest.js";

/** Response header carrying Ed25519 signature over the exact UTF-8 body bytes sent. */
export const MANIFEST_SIGNATURE_HEADER = "x-hive-manifest-signature";

/** Prefix for Ed25519 detached signatures (64 bytes, base64). */
export const MANIFEST_SIGNATURE_PREFIX = "v1-ed25519-";

/**
 * Deterministic JSON for signing so server and verifier agree on byte representation.
 * Recursively sorts object keys lexicographically.
 */
export function stableStringifyProvisionManifest(m: WorkerProvisionManifest): string {
  return stableJsonStringify(m);
}

function stableJsonStringify(v: unknown): string {
  if (v === null || typeof v !== "object") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(stableJsonStringify).join(",")}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(o[k])}`).join(",")}}`;
}

export function signProvisionManifestBody(bodyUtf8: string, privateKey: KeyObject): Buffer {
  return sign(null, Buffer.from(bodyUtf8, "utf8"), privateKey);
}

export function formatSignatureHeader(signatureBytes: Buffer): string {
  return `${MANIFEST_SIGNATURE_PREFIX}${signatureBytes.toString("base64")}`;
}

export function createPrivateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/**
 * Load PEM-encoded Ed25519 private key for signing manifests.
 * Prefer HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE; else inline PEM or base64-of-PEM in HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY.
 */
export function loadProvisionManifestSigningKeyPemFromEnv(env: NodeJS.ProcessEnv): string | null {
  const file = env.HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE?.trim();
  if (file) {
    if (!existsSync(file)) {
      throw new Error(`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE not found: ${file}`);
    }
    return readFileSync(file, "utf8");
  }
  const inline = env.HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY?.trim();
  if (!inline) return null;
  if (inline.includes("BEGIN")) {
    return inline.replace(/\\n/g, "\n");
  }
  try {
    return Buffer.from(inline, "base64").toString("utf8");
  } catch {
    throw new Error("HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY must be PEM or base64-encoded PEM");
  }
}

/** Send JSON body with optional Ed25519 signature header (same UTF-8 bytes as signed). */
export function sendSignedProvisionManifestJson(
  res: Response,
  manifest: WorkerProvisionManifest,
  signingKeyPem: string | null | undefined,
  setHeaders: () => void,
): void {
  const body = stableStringifyProvisionManifest(manifest);
  if (signingKeyPem) {
    const key = createPrivateKeyFromPem(signingKeyPem);
    const sig = signProvisionManifestBody(body, key);
    res.setHeader(MANIFEST_SIGNATURE_HEADER, formatSignatureHeader(sig));
  }
  setHeaders();
  res.status(200).type("json").send(body);
}
