/** Postgres undefined_column — e.g. `worker_instances` migration 0035 not applied yet. */
export function isPgUndefinedColumnError(err: unknown): boolean {
  const walk = (e: unknown): boolean => {
    if (e == null) return false;
    const o = e as { code?: string; message?: string; cause?: unknown };
    if (o.code === "42703") return true;
    if (typeof o.message === "string" && /column .+ does not exist/i.test(o.message)) return true;
    return walk(o.cause);
  };
  return walk(err);
}
