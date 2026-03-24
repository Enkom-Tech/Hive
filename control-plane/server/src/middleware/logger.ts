import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";

function sanitizeUrlForLogs(url: unknown): string {
  if (typeof url !== "string") return "";
  return url.split("?")[0] || url;
}

function safeSanitizeForLogs(value: unknown): unknown {
  try {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactCurrentUserValue(value);
    if (Array.isArray(value)) {
      // sanitizeRecord() can handle arrays passed as records, but recursion is clearer and safer for mixed arrays.
      return value.map((entry) => safeSanitizeForLogs(entry));
    }
    if (typeof value === "object") {
      return redactCurrentUserValue(sanitizeRecord(value as Record<string, unknown>));
    }
    return value;
  } catch {
    // Logging must never throw; fall back to the original value.
    return value;
  }
}

function resolveServerLogDir(): string {
  const envOverride = (process.env.HIVE_LOG_DIR ?? process.env.HIVE_LOG_DIR)?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    // pino-http serializes `req` by default and includes `req.url` (with query string).
    // We must remove query params and sanitize token/secret-like fields before logging.
    req(req: unknown) {
      const rawReq = req as any;
      return {
        id: rawReq?.id,
        method: rawReq?.method,
        url: sanitizeUrlForLogs(rawReq?.url),
        query: safeSanitizeForLogs(rawReq?.query),
        params: safeSanitizeForLogs(rawReq?.params),
        headers: safeSanitizeForLogs(rawReq?.headers),
        remoteAddress: rawReq?.remoteAddress,
        remotePort: rawReq?.remotePort,
      };
    },
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${sanitizeUrlForLogs(req.url)} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${sanitizeUrlForLogs(req.url)} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const rawReq = req as any;
      const sanitizedReq = {
        // kept minimal; req itself is also handled by serializers.req
        url: sanitizeUrlForLogs(rawReq.url),
      };

      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          reqUrl: sanitizedReq.url,
          errorContext: safeSanitizeForLogs(ctx.error),
          reqBody: safeSanitizeForLogs(ctx.reqBody),
          reqParams: safeSanitizeForLogs(ctx.reqParams),
          reqQuery: safeSanitizeForLogs(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      props.req = sanitizedReq;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = safeSanitizeForLogs(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = safeSanitizeForLogs(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = safeSanitizeForLogs(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
