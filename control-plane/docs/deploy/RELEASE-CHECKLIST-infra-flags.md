# Release checklist: infra feature flags

Use this matrix when cutting control-plane + `hive-worker` releases that touch placement, deploy grants, workspace delegation, or VCS webhooks.

| Flag / area | Staging | Production notes |
|-------------|---------|------------------|
| `HIVE_PLACEMENT_V1_ENABLED` | Exercise dispatch + `placement_mismatch` ack | Worker semver must match DRONE-SPEC |
| `HIVE_AUTO_PLACEMENT_ENABLED` | Bind/unbind + pool rotate | Coordinate with `HIVE_DRAIN_*` |
| `HIVE_DRAIN_CANCEL_IN_FLIGHT_PLACEMENTS_ENABLED` | Mark instance draining; confirm runs cancel + placement `worker_draining` | Default on |
| `HIVE_DRAIN_AUTO_EVACUATE_ENABLED` | Evacuate automatic bindings | Requires spare capacity |
| `HIVE_REQUEST_DEPLOY_ENABLED` (CP + worker) | Grant pull + cosign (if `HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH`) | Rotate `HIVE_DEPLOY_GRANT_SECRET` |
| `HIVE_CONTAINER_IMAGE_ENFORCE` + `HIVE_CONTAINER_IMAGE_ALLOWLIST` | Deny non-listed image | Required when container adapter is on |
| `HIVE_VCS_GITHUB_WEBHOOK_ENABLED` + `HIVE_VCS_GITHUB_WEBHOOK_SECRET` | Deliver synthetic `pull_request` closed merged | Optional `HIVE_VCS_GITHUB_ALLOWED_REPOS` |
| Worker `HIVE_WORKSPACE_MATERIALIZE_ENABLED` + token | Clone smoke against test repo | Never log token |
| Worker `HIVE_WORKSPACE_ARTIFACT_FETCH_ENABLED` | Tarball fetch + sha256 | Cap size in runbook |
| Worker `HIVE_WORKER_POLICY_SECRET` + CP **`HIVE_WORKER_CONTAINER_POLICY_ALLOWLIST_CSV`** (same secret on API) | CP auto-sends signed `worker_container_policy` after link hello; worker verifies | Rotate together; optional CP `HIVE_WORKER_CONTAINER_POLICY_VERSION` / `_EXPIRES_AT` |
| **`HIVE_WORKSPACE_REMOTE_EXEC_GUARD`** (CP) | Fail git-worktree runs when remote drones cannot see CP-local paths | Enable when using remote worker pool + isolated workspaces |

Rollback: revert to prior **paired** API + worker images; DB migrations are forward-only.
