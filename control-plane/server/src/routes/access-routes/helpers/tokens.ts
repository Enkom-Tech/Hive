import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export const INVITE_TOKEN_PREFIX = "pcp_invite_";
export const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const INVITE_TOKEN_SUFFIX_LENGTH = 8;
export const INVITE_TOKEN_MAX_RETRIES = 5;
const COMPANY_INVITE_TTL_MS = 10 * 60 * 1000;

export function createInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

export function createClaimSecret() {
  return `pcp_claim_${randomBytes(24).toString("hex")}`;
}

export function companyInviteExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + COMPANY_INVITE_TTL_MS);
}

export function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function isInviteTokenHashCollisionError(error: unknown) {
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    if (code !== "23505") continue;
    if (constraint === "invites_token_hash_unique_idx") return true;
    if (message.includes("invites_token_hash_unique_idx")) return true;
  }
  return false;
}
