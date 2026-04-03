# Worker WebSocket: `worker_container_policy`

Workers merge **extra** container image allowlist prefixes when they receive a signed message on the managed-worker link (same socket as `run` / `deploy_grant`).

## Environment

- Worker: **`HIVE_WORKER_POLICY_SECRET`** — shared symmetric secret (rotate with care).
- Merged with static **`HIVE_CONTAINER_IMAGE_ALLOWLIST`** in [`infra/worker/internal/executor/container_allowlist.go`](../../../infra/worker/internal/executor/container_allowlist.go).

## Message shape

```json
{
  "type": "worker_container_policy",
  "version": "1",
  "allowlistCsv": "ghcr.io/my-org/,registry.example.com/project/",
  "expiresAt": "2026-12-31T23:59:59Z",
  "signature": "<hex HMAC-SHA256>"
}
```

## Signature

`signature` is **hex-encoded HMAC-SHA256** over UTF-8:

`version + "|" + allowlistCsv + "|" + expiresAt`

using **`HIVE_WORKER_POLICY_SECRET`** as the HMAC key.

When the control plane is configured with **`HIVE_WORKER_POLICY_SECRET`** (same value as on the worker) and **`HIVE_WORKER_CONTAINER_POLICY_ALLOWLIST_CSV`**, it **automatically** sends a signed `worker_container_policy` frame after **`worker_api_token`** on instance-scoped link connect and after provision **`hello`**. Delivery uses the same path as **`run`** frames: **local WebSocket** for the `worker_instances` row, then **`HIVE_WORKER_DELIVERY_BUS_URL`** (Redis) when the socket lives on another API replica. Optional: **`HIVE_WORKER_CONTAINER_POLICY_VERSION`** (default `1`), **`HIVE_WORKER_CONTAINER_POLICY_EXPIRES_AT`** (ISO-8601, may be empty). Operators may still inject additional policy updates from automation on the link using the same signing rule.

## Related

- [DRONE-SPEC.md](../../doc/DRONE-SPEC.md) §10  
- [threat-model-managed-worker-pool.md](../../doc/plans/threat-model-managed-worker-pool.md)  
