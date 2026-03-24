export type HealthStatus = {
  status: "ok";
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  auth?: {
    signUpDisabled?: boolean;
  };
  features?: {
    companyDeletionEnabled?: boolean;
  };
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    let res: Response;
    try {
      res = await fetch("/api/health", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new Error(msg || "Failed to fetch");
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        `Non-JSON response from /api/health (${contentType || "unknown type"}). The UI may be running without the API.`,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new Error(
        "Non-JSON response from /api/health (body was not valid JSON). The UI may be running without the API.",
      );
    }
  },
};
