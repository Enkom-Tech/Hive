import type { DeploymentExposure, DeploymentMode } from "@hive/shared";

export type JoinDiagnostic = {
  code: string;
  level: "info" | "warn";
  message: string;
  hint?: string;
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHeaderValue(
  value: unknown,
  depth: number = 0,
): string | null {
  const direct = nonEmptyTrimmedString(value);
  if (direct) return direct;
  if (!isPlainObject(value) || depth >= 3) return null;

  const candidateKeys = [
    "value",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "auth",
    "authToken",
    "auth_token",
    "accessToken",
    "access_token",
    "authorization",
    "bearer",
    "header",
    "raw",
    "text",
    "string",
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeHeaderValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
    if (normalized) return normalized;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [singleKey, singleValue] = entries[0]!;
    const normalizedKey = singleKey.trim().toLowerCase();
    if (
      normalizedKey !== "type" &&
      normalizedKey !== "version" &&
      normalizedKey !== "secretid" &&
      normalizedKey !== "secret_id"
    ) {
      const normalized = normalizeHeaderValue(singleValue, depth + 1);
      if (normalized) return normalized;
    }
  }

  return null;
}

function extractHeaderEntries(input: unknown): Array<[string, unknown]> {
  if (isPlainObject(input)) {
    return Object.entries(input);
  }
  if (!Array.isArray(input)) {
    return [];
  }

  const entries: Array<[string, unknown]> = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const key = nonEmptyTrimmedString(item[0]);
      if (!key) continue;
      entries.push([key, item[1]]);
      continue;
    }
    if (!isPlainObject(item)) continue;

    const mapped = item as Record<string, unknown>;
    const explicitKey =
      nonEmptyTrimmedString(mapped.key) ??
      nonEmptyTrimmedString(mapped.name) ??
      nonEmptyTrimmedString(mapped.header);
    if (explicitKey) {
      const explicitValue = Object.prototype.hasOwnProperty.call(
        mapped,
        "value",
      )
        ? mapped.value
        : Object.prototype.hasOwnProperty.call(mapped, "token")
          ? mapped.token
          : Object.prototype.hasOwnProperty.call(mapped, "secret")
            ? mapped.secret
            : mapped;
      entries.push([explicitKey, explicitValue]);
      continue;
    }

    const singleEntry = Object.entries(mapped);
    if (singleEntry.length === 1) {
      entries.push(singleEntry[0] as [string, unknown]);
    }
  }

  return entries;
}

function normalizeHeaderMap(
  input: unknown,
): Record<string, string> | undefined {
  const entries = extractHeaderEntries(input);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedValue = normalizeHeaderValue(value);
    if (!normalizedValue) continue;
    const trimmedKey = key.trim();
    const trimmedValue = normalizedValue.trim();
    if (!trimmedKey || !trimmedValue) continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildJoinDefaultsPayloadForAccept(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  hiveApiUrl?: unknown;
  inboundGatewayAuthHeader?: string | null;
  inboundGatewayTokenHeader?: string | null;
}): unknown {
  return input.defaultsPayload;
}

export function mergeJoinDefaultsPayloadForReplay(
  existingDefaultsPayload: unknown,
  nextDefaultsPayload: unknown,
): unknown {
  if (
    !isPlainObject(existingDefaultsPayload) &&
    !isPlainObject(nextDefaultsPayload)
  ) {
    return nextDefaultsPayload ?? existingDefaultsPayload;
  }
  if (!isPlainObject(existingDefaultsPayload)) {
    return nextDefaultsPayload;
  }
  if (!isPlainObject(nextDefaultsPayload)) {
    return existingDefaultsPayload;
  }

  const merged: Record<string, unknown> = {
    ...(existingDefaultsPayload as Record<string, unknown>),
    ...(nextDefaultsPayload as Record<string, unknown>),
  };

  const existingHeaders = normalizeHeaderMap(
    (existingDefaultsPayload as Record<string, unknown>).headers,
  );
  const nextHeaders = normalizeHeaderMap(
    (nextDefaultsPayload as Record<string, unknown>).headers,
  );
  if (existingHeaders || nextHeaders) {
    merged.headers = {
      ...(existingHeaders ?? {}),
      ...(nextHeaders ?? {}),
    };
  } else if (Object.prototype.hasOwnProperty.call(merged, "headers")) {
    delete merged.headers;
  }

  return merged;
}

export function normalizeAgentDefaultsForJoin(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}) {
  const diagnostics: JoinDiagnostic[] = [];
  const fatalErrors: string[] = [];
  const normalized = isPlainObject(input.defaultsPayload)
    ? (input.defaultsPayload as Record<string, unknown>)
    : null;
  return { normalized, diagnostics, fatalErrors };
}
