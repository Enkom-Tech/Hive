import { ZodError } from "zod";
import { HttpError } from "../errors.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

interface ErrorRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
}

interface ErrorResponse {
  status(code: number): this;
  json(body: unknown): void;
  [key: string]: unknown;
}

function attachErrorContext(
  req: ErrorRequest,
  res: ErrorResponse,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as Record<string, unknown>).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl ?? req.url ?? "",
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as Record<string, unknown>).err = rawError;
  }
}

export function errorHandler(
  err: unknown,
  req: ErrorRequest,
  res: ErrorResponse,
  _next: (err?: unknown) => void,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.issues });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  res.status(500).json({ error: "Internal server error" });
}
