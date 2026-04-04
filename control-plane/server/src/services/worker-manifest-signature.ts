import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { WorkerProvisionManifest } from "./worker-provision-manifest.js";

/** Minimal interface for response objects that can receive a manifest payload. */
export interface ManifestResponseSink {
  setHeader(name: string, value: string): void;
  status(code: number): this;
  type(ct: string): this;
  send(body: string): void;
}

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

/**
 * Build the signed manifest response data without framework-specific I/O.
 * Returns the body string and optional signature header value.
 */
export function buildSignedProvisionManifestResponse(
  manifest: WorkerProvisionManifest,
  signingKeyPem: string | null | undefined,
): { body: string; signatureHeader: string | null } {
  const body = stableStringifyProvisionManifest(manifest);
  if (signingKeyPem) {
    const key = createPrivateKeyFromPem(signingKeyPem);
    const sig = signProvisionManifestBody(body, key);
    return { body, signatureHeader: formatSignatureHeader(sig) };
  }
  return { body, signatureHeader: null };
}

/** Send JSON body with optional Ed25519 signature header (same UTF-8 bytes as signed). */
export function sendSignedProvisionManifestJson(
  res: ManifestResponseSink,
  manifest: WorkerProvisionManifest,
  signingKeyPem: string | null | undefined,
  setHeaders: () => void,
): void {
  const { body, signatureHeader } = buildSignedProvisionManifestResponse(manifest, signingKeyPem);
  if (signatureHeader) {
    res.setHeader(MANIFEST_SIGNATURE_HEADER, signatureHeader);
  }
  setHeaders();
  res.status(200).type("json").send(body);
}

/** Send JSON body with optional Ed25519 signature header via a raw Node ServerResponse. */
export function sendSignedProvisionManifestJsonRaw(
  res: ServerResponse,
  manifest: WorkerProvisionManifest,
  signingKeyPem: string | null | undefined,
  setHeaders: () => void,
): void {
  const { body, signatureHeader } = buildSignedProvisionManifestResponse(manifest, signingKeyPem);
  if (signatureHeader) {
    res.setHeader(MANIFEST_SIGNATURE_HEADER, signatureHeader);
  }
  setHeaders();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
}
