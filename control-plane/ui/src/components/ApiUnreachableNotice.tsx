import { apiUnreachableUserMessage } from "@/lib/api-unreachable";

type Props = {
  error?: unknown;
};

export function ApiUnreachableNotice({ error }: Props) {
  const message = apiUnreachableUserMessage(error ?? new Error("Failed to fetch"));
  return (
    <div className="mx-auto max-w-xl py-10 px-4">
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-6"
        role="alert"
        aria-live="polite"
      >
        <h1 className="text-xl font-semibold text-destructive">Control plane unavailable</h1>
        <p className="mt-3 text-sm text-muted-foreground whitespace-pre-line">{message}</p>
      </div>
    </div>
  );
}
