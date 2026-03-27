# ADR 007: Remote execution workspace materialization

**Status:** Accepted (documentation / decision record)  
**Date:** 2026-03-27  
**Context:** The control plane can realize git worktrees on the host where it runs. `hive-worker` applies `context.hiveWorkspace` only when that path exists on the **drone** host and under `HIVE_WORKSPACE` (see `infra/worker/internal/link/link.go`).

## Decision

Operators choose **one** of these patterns per deployment; the product does not mandate automatic cross-host sync in v1.

1. **Colocation (default recommendation):** Run the control plane and `hive-worker` on the same filesystem (same VM, bind-mounted repo, or shared volume) so realized worktree paths are valid for both.
2. **Worker-side materialization (future build):** Extend run context with repo URL, ref, and worktree recipe; the worker runs `git clone` / `worktree` under `HIVE_WORKSPACE`. Requires credential strategy (read-only deploy keys, short-lived tokens), disk quotas, and network policy. Not implemented in this ADR.
3. **Artifact sync (future build):** Control plane publishes a signed archive or object-store URL; worker fetches and extracts before run. Highest operational cost; not implemented in this ADR.

## Consequences

- Documentation and UI copy must describe the colocation requirement for isolated issue checkouts with remote drones.
- Threat model for option 2 must cover secret exfiltration, supply chain (malicious refs), and repo size DoS before implementation.

## Related

- `doc/experimental/issue-worktree-support.md`  
- `doc/plans/workspace-strategy-and-git-worktrees.md` Phase 8  
- `doc/DRONE-SPEC.md` workspace rows  
