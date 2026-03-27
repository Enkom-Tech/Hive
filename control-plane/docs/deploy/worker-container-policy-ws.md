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

The control plane does not yet broadcast this automatically; operators may send it from automation connected to the worker link, or add an internal API that uses the same signing rule.

## Related

- [DRONE-SPEC.md](../../doc/DRONE-SPEC.md) §10  
- [threat-model-managed-worker-pool.md](../../doc/plans/threat-model-managed-worker-pool.md)  
