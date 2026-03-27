# ADR 006: request_deploy (grant-based image pull)

## Status

Accepted — implemented behind feature flags.

## Context

Workers need a controlled path to pull verifier-approved OCI images without giving unrestricted registry access to agent code.

## Decision

1. **Board** creates a **deploy request** (API) with digest-pinned reference and optional cosign requirement.
2. Control plane stores the request and may emit a **`deploy_grant`** WebSocket message (or worker polls) containing **grantId**, **imageRef** (digest), **expiresAt**, and **signature** (HMAC over fields using operator secret).
3. **`POST .../deploy-grants`** rejects non–digest-pinned `imageRef` with **422**; the worker rejects grants whose `imageRef` does not end with **`@sha256:`** plus 64 hex chars before registry checks.
4. Worker validates grant, shared secret, optional `HIVE_COMPANY_ID` match, allowlist env **`HIVE_DEPLOY_ALLOWED_REGISTRIES`**, then applies **`HIVE_CONTAINER_IMAGE_ALLOWLIST` / `HIVE_CONTAINER_IMAGE_ENFORCE`** (same rules as `docker run`) before **`docker pull`** when `HIVE_REQUEST_DEPLOY_ENABLED` is set. Optional **cosign** verification runs after a successful pull when **`HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH`** is set (uses `cosign verify` CLI; **`HIVE_COSIGN_BINARY`** overrides binary name).

**Rollout checklist:** Rotate **`HIVE_DEPLOY_GRANT_SECRET`** on a schedule; keep worker version aligned with control plane; enable flags only after staging pull + mismatch tests; monitor worker logs for `deploy_grant: container image policy` denials.

## Consequences

- No worker-initiated deploy without a prior server grant.
- Audit rows / activity log on grant use.
- Transport TLS remains standard HTTPS to registries; signing policy for images uses Sigstore/cosign as configured by the operator.
