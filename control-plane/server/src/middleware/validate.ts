import type { ZodSchema } from "zod";

interface BodyRequest {
  body?: unknown;
}

export function validate(schema: ZodSchema) {
  return (req: BodyRequest, _res: unknown, next: (err?: unknown) => void) => {
    req.body = schema.parse(req.body);
    next();
  };
}
