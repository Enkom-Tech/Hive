import { createHash, randomBytes } from "node:crypto";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

export function createLinkEnrollmentTokenPlain() {
  return `hive_wen_${randomBytes(24).toString("base64url")}`;
}

export function createDroneProvisioningTokenPlain() {
  return `hive_dpv_${randomBytes(24).toString("base64url")}`;
}
