export type PluginHostRpcRequest = {
  instanceId: string;
  method: "ping";
};

export type PluginHostRpcResponse = { ok: true; method: string } | { ok: false; error: string };

/**
 * Minimal fetch-based client for the internal plugin host HTTP RPC (Bearer token).
 * Third-party plugins use this from a sidecar; the host URL and token are provisioned at runtime.
 */
export async function invokePluginHostRpc(
  baseUrl: string,
  bearerToken: string,
  body: PluginHostRpcRequest,
): Promise<PluginHostRpcResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/internal/plugin-host/rpc`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as PluginHostRpcResponse;
  return data;
}
