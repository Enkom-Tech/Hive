# Threat model: worker-side execution workspace materialization (ADR 007 option 2)

**Status:** Reference for Phase 3 implementation  
**Date:** 2026-03-27  
**Scope:** Worker process performs `git clone` / `worktree` (or similar) under `HIVE_WORKSPACE` using credentials and refs supplied by the control plane in the run envelope.

## Assets

- Read-only repository credentials (tokens, deploy keys)
- Worker disk and network egress
- Subsequent agent runs using the materialized tree

## Adversaries

- Malicious or compromised control plane (supply chain)
- Malicious repo content (hooks, huge objects, submodule tricks)
- Network MITM (TLS + pinning policy operator-defined)

## STRIDE summary

| Threat | Mitigation |
|--------|------------|
| **Spoofing** | Run envelope signed or delivered only over authenticated WebSocket; worker trusts CP only after mutual auth |
| **Tampering** | Digest-pin or ref allowlist where product allows; reject unexpected fields |
| **Repudiation** | Log materialization start/finish with run id; redact URLs containing secrets |
| **Information disclosure** | Never log tokens; short-lived credentials preferred |
| **Denial of service** | Disk quota, clone timeout, shallow clone option, max repo size / object count limits |
| **Elevation** | Disable git hooks (`core.hooksPath` / env), avoid executing repo-supplied binaries during clone; sanitize paths |

## Git-specific notes

- Prefer strategies documented with the implementation: e.g. `GIT_CONFIG_GLOBAL` / `-c` flags to reduce hook execution risk.
- Malicious `.gitmodules` and LFS can amplify fetch cost—enforce timeouts and failure policies.

## Related

- [ADR 007 — Remote execution workspace materialization](../adr/007-remote-execution-workspace.md)  
- [threat-model-vcs-webhooks.md](threat-model-vcs-webhooks.md)  
- [DRONE-SPEC.md](../DRONE-SPEC.md) §10 workspace row  
