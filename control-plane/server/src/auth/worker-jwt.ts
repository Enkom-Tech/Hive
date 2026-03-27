import { createHmac, timingSafeEqual } from "node:crypto";

const JWT_ALGORITHM = "HS256";

export interface WorkerJwtClaims {
  sub: string;
  company_id: string;
  kind: "worker_instance";
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
}

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function workerJwtSecret(): string | null {
  const secret = process.env.HIVE_WORKER_JWT_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

function workerJwtConfig() {
  const secret = workerJwtSecret();
  if (!secret) return null;
  const ttlSeconds = parseNumber(process.env.HIVE_WORKER_JWT_TTL_SECONDS, 24 * 3600);
  return {
    secret,
    ttlSeconds,
    issuer: process.env.HIVE_WORKER_JWT_ISSUER ?? "hive",
    audience: process.env.HIVE_WORKER_JWT_AUDIENCE ?? "hive-worker-api",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Mint a short-lived JWT for a worker instance (drone). Requires HIVE_WORKER_JWT_SECRET. */
export function createWorkerJwt(workerInstanceRowId: string, companyId: string): string | null {
  const config = workerJwtConfig();
  if (!config) return null;
  const sub = workerInstanceRowId.trim();
  const company_id = companyId.trim();
  if (!sub || !company_id) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: WorkerJwtClaims = {
    sub,
    company_id,
    kind: "worker_instance",
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function mintWorkerApiToken(
  workerInstanceRowId: string,
  companyId: string,
): { token: string; expiresAt: Date } | null {
  const config = workerJwtConfig();
  if (!config) return null;
  const token = createWorkerJwt(workerInstanceRowId, companyId);
  if (!token) return null;
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
  return { token, expiresAt };
}

export function verifyWorkerJwt(token: string): WorkerJwtClaims | null {
  if (!token) return null;
  const config = workerJwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  if (claims.kind !== "worker_instance") return null;

  const sub = typeof claims.sub === "string" ? claims.sub.trim() : null;
  const company_id = typeof claims.company_id === "string" ? claims.company_id.trim() : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !company_id || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  return {
    sub,
    company_id,
    kind: "worker_instance",
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
  };
}
