import { createHmac, timingSafeEqual } from "node:crypto";

const JWT_ALGORITHM = "HS256";

export interface BoardJwtClaims {
  sub: string;
  company_ids: string[];
  instance_admin: boolean;
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

function boardJwtSecret(): string | null {
  const secret =
    process.env.HIVE_BOARD_JWT_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    process.env.HIVE_AGENT_JWT_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

function boardJwtConfig() {
  const secret = boardJwtSecret();
  if (!secret) return null;
  const ttlSeconds = parseNumber(process.env.HIVE_BOARD_JWT_TTL_SECONDS, 15 * 60); // default 15 min
  return {
    secret,
    ttlSeconds,
    issuer: process.env.HIVE_BOARD_JWT_ISSUER ?? "hive",
    audience: process.env.HIVE_BOARD_JWT_AUDIENCE ?? "hive-api",
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

export function issueBoardJwt(
  userId: string,
  companyIds: string[],
  isInstanceAdmin: boolean,
): string | null {
  const config = boardJwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: BoardJwtClaims = {
    sub: userId,
    company_ids: companyIds,
    instance_admin: isInstanceAdmin,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput =
    `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function verifyBoardJwt(token: string): BoardJwtClaims | null {
  if (!token) return null;
  const config = boardJwtConfig();
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

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const companyIdsRaw = claims.company_ids;
  const companyIds =
    Array.isArray(companyIdsRaw) && companyIdsRaw.every((c): c is string => typeof c === "string")
      ? companyIdsRaw
      : [];
  const isInstanceAdmin = claims.instance_admin === true;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  return {
    sub,
    company_ids: companyIds,
    instance_admin: isInstanceAdmin,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
  };
}
