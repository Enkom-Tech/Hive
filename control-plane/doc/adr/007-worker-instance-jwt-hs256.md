# ADR 007: Worker-instance JWT uses HS256 (symmetric)

## Status

Accepted. **Next review:** 2027-03-01 (or sooner if organizational cryptographic policy tightens).

## Context

The control plane mints short-lived **worker-instance** JWTs (`worker_api_token` over the worker WebSocket) and verifies `Authorization: Bearer` on `/api/worker-api/*` using a shared secret (`HIVE_WORKER_JWT_SECRET`). Implementation: [`server/src/auth/worker-jwt.ts`](../../server/src/auth/worker-jwt.ts) (HS256).

Some deployment policies require post-quantum or asymmetric-only trust anchors for all tokens. HS256 is neither post-quantum nor asymmetric.

## Decision

1. **Keep HS256 for worker-instance JWTs** in Scope 1: it matches the existing control-plane stack, avoids per-request public-key fetches, and keeps the drone bootstrap path simple (secret already held only on the API).
2. **Treat the JWT as an internal session credential**, not a long-lived trust root: short TTL, rotation via single-secret rollout (see [security runbook — Worker-instance JWT](../../docs/deploy/security-runbook.md)), network isolation for worker pods.
3. **Future v2 (out of band):** If policy mandates PQC or asymmetric worker tokens, replace mint/verify with a reviewed algorithm (e.g. ML-DSA / SLH-DSA per NIST, or hybrid signing) and document a coordinated migration; do not silently mix v1 and v2 without explicit versioned `typ` or `kid` handling.

## Consequences

- Security reviews must record this **explicit exception** where org policy would otherwise forbid symmetric MAC JWTs.
- Operators rely on **secret hygiene** (entropy, rotation, mount as K8s Secret) rather than on PQC properties of the JWT algorithm itself.
