# Threat model: inbound VCS webhooks (merge-driven workspace cleanup)

**Status:** Reference for Phase 2 implementation  
**Date:** 2026-03-27  
**Scope:** HTTP endpoints that accept GitHub/GitLab (etc.) delivery payloads to drive Hive-side actions (e.g. execution workspace teardown when a branch merges).

## Assets

- Company-scoped git metadata and issue ↔ branch linkage
- Idempotency store (delivery deduplication)
- Ability to trigger `git worktree remove` and project teardown commands (side effects on operator filesystem when colocated)

## Adversaries

- Anonymous internet actors hitting public webhook URLs
- Compromised VCS org sending malicious payloads
- Replay of captured legitimate deliveries

## STRIDE summary

| Threat | Mitigation |
|--------|------------|
| **Spoofing** | HMAC or provider signature verification with **constant-time** compare; per-integration secret in company or instance secret store |
| **Tampering** | Verify signature over raw body; reject if body parsed before verify |
| **Repudiation** | Persist `activity_log` entries for accepted actions; optional correlation id from provider |
| **Information disclosure** | Generic 404/401 on failure; no stack traces; do not log secrets or full payloads in production |
| **Denial of service** | Rate limit per route and per integration id; cap payload size; timeout handler work |
| **Elevation** | Strict company + repo allowlist; branch→issue mapping only for known projects; no arbitrary command execution from payload |

## Implementation checklist

1. Raw body available for signature verification (before JSON parse).
2. Idempotency key: provider delivery id + integration id; store outcome to prevent double teardown.
3. Map events only to issues in the integration’s company; reject cross-tenant repo URLs.
4. Optional remote branch delete remains **off** by default and requires explicit project flag.

## Related

- [threat-model-worker-workspace-materialization.md](threat-model-worker-workspace-materialization.md)  
- [workspace-strategy-and-git-worktrees.md](workspace-strategy-and-git-worktrees.md) Phase 8  
- [SPEC-implementation.md](../SPEC-implementation.md) §5.1.1  
