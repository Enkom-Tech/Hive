/**
 * HTTP client for Bifrost governance API (virtual keys).
 * Base URL should be the gateway root (e.g. http://bifrost:8080), without trailing slash.
 */

export type BifrostProviderConfigInput = {
  provider: string;
  weight: number;
  allowed_models?: string[];
};

export type BifrostCreateVirtualKeyResult = {
  bifrostId: string;
  /** Plaintext sk-bf-* (return once to the board; do not log). */
  value: string;
};

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export async function bifrostCreateVirtualKey(
  baseUrl: string,
  adminToken: string,
  body: {
    name: string;
    description?: string | null;
    customer_id?: string;
    provider_configs: BifrostProviderConfigInput[];
    is_active?: boolean;
  },
): Promise<BifrostCreateVirtualKeyResult> {
  const root = trimSlash(baseUrl.trim());
  const url = `${root}/api/governance/virtual-keys`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(adminToken.trim() ? { Authorization: `Bearer ${adminToken.trim()}` } : {}),
    },
    body: JSON.stringify({
      name: body.name,
      description: body.description ?? undefined,
      customer_id: body.customer_id,
      provider_configs: body.provider_configs,
      is_active: body.is_active ?? true,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Bifrost virtual key create failed (${res.status}): ${raw.slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Bifrost virtual key create: invalid JSON body");
  }
  const obj = parsed as {
    virtual_key?: { id?: string; value?: string };
  };
  const id = obj.virtual_key?.id;
  const value = obj.virtual_key?.value;
  if (typeof id !== "string" || !id || typeof value !== "string" || !value) {
    throw new Error("Bifrost virtual key create: missing virtual_key.id or virtual_key.value");
  }
  return { bifrostId: id, value };
}
