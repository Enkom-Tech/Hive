/** User-facing guidance when the UI cannot talk to the control plane API. */
export const API_UNREACHABLE_HINT =
  "Run the full stack from the repository root (for example `pnpm dev`, which serves the UI and API together). If you use only the Vite dev server for the UI, start the API on port 3100 so `/api` can be proxied.";

export function isLikelyApiUnreachableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  if (m.includes("failed to fetch")) return true;
  if (m.includes("networkerror")) return true;
  if (m.includes("network request failed")) return true;
  if (m === "load failed") return true;
  if (m.includes("could not connect")) return true;
  if (m.includes("connection refused")) return true;
  if (m.includes("non-json response") || m.includes("did not return json")) return true;
  return false;
}

export function apiUnreachableUserMessage(err: unknown): string {
  if (isLikelyApiUnreachableError(err)) {
    return `The control plane API is not reachable from this page.\n\n${API_UNREACHABLE_HINT}`;
  }
  if (err instanceof Error && err.message.toLowerCase().includes("too many requests")) {
    return (
      "The server temporarily rate-limited this browser (HTTP 429). Wait a short time and refresh the page.\n\n" +
      "If this keeps happening during local development, raise HIVE_RATE_LIMIT_MAX or HIVE_RATE_LIMIT_WINDOW_MS " +
      "in the server environment."
    );
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  return "Request failed.";
}
