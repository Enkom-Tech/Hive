# Issue worktree support

Status: experimental. Runtime verified; UI re-enabled after path safety, provision behavior, and workflow finalization.

This document describes the runtime and seeding work for issue-scoped worktrees:

- project execution workspace policy support
- issue-level execution workspace settings
- git worktree realization for isolated issue execution
- optional command-based worktree provisioning
- seeded worktree fixes for secrets key compatibility
- seeded project workspace rebinding to the current git worktree

The UI entrypoints are enabled (`SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = true` in ProjectProperties, NewIssueDialog, IssueProperties, runtime-json-fields).

## What works today

- projects can carry execution workspace policy in the backend
- issues can carry execution workspace settings in the backend
- heartbeat execution can realize isolated git worktrees
- runtime can run a project-defined provision command inside the derived worktree
- seeded worktree instances can keep local-encrypted secrets working
- seeded worktree instances can rebind same-repo project workspace paths onto the current git worktree

## Teardown and cleanup

When the project `execution_workspace_policy.cleanupPolicy.mode` is **`on_done`**, the control plane runs `teardownCommand` (if set) and `git worktree remove --force` after an issue moves to **`done`** or **`cancelled`** (see `teardownIssueExecutionWorkspaceOnTerminal` in `server/src/services/workspace-runtime.ts`). Otherwise cleanup remains manual. Merge-driven cleanup is still future work (workspace-strategy Phase 8).

## UI entrypoints

User-facing surfaces for the feature (gated by `SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI`; currently enabled):

- project settings:
  - `ui/src/components/ProjectProperties.tsx`
  - execution workspace policy controls
  - git worktree base ref / branch template / parent dir
  - provision / teardown command inputs

- issue creation:
  - `ui/src/components/NewIssueDialog.tsx`
  - isolated issue checkout toggle
  - defaulting issue execution workspace settings from project policy

- issue editing:
  - `ui/src/components/IssueProperties.tsx`
  - issue-level workspace mode toggle
  - defaulting issue execution workspace settings when project changes

- agent/runtime settings:
  - `ui/src/adapters/runtime-json-fields.tsx`
  - runtime services JSON field, which is part of the broader workspace-runtime support surface

## Why this remains experimental

- **`on_done` teardown** runs for **done** and **cancelled**; **`on_merged`** runs for **done** only (cancelled leaves the worktree). Set `cleanupPolicy.mode` on the project policy accordingly. Further merge-detection (VCS webhooks) remains future work (workspace-strategy Phase 8).
- **`hiveWorkspace` on the worker:** `hive-worker` sets process/container cwd from `context.hiveWorkspace` when the path exists **on the drone host** and lies under the configured workspace root (`workspaceDirFromContext` in `infra/worker/internal/link/link.go`). If the control plane created a git worktree only on the **control-plane** machine, a **remote** drone cannot see that filesystem path—this is a **topology / materialization** gap, not absent cwd wiring. Colocate worker and repo, or implement remote checkout/sync (see [ADR 007](../adr/007-remote-execution-workspace.md)).
- Product-level E2E verification of the full UI workflow is recommended before removing the experimental flag.

## Defaults

- Project execution workspace policy: `enabled: false`, `defaultMode: project_primary`. New issues inherit from project (no isolated checkout unless the project enables execution workspace and defaults to isolated).
- When re-enabling the UI, keep these defaults so existing projects are unchanged.

## Operator runbook

1. Enable execution workspace on the project (optional). In project settings, turn on "Enable isolated issue checkouts".
2. Optionally set worktree parent dir (default: `.hive/worktrees` under the repo root). Base ref, branch template, and provision/teardown commands are in advanced settings.
3. Create or edit an issue: choose "Isolated issue checkout" (or "isolated execution workspace") for that issue when you want a dedicated branch/worktree for it.
4. On run: the agent gets the worktree as cwd; the board sees branch and path in the workspace-ready comment and run context.
5. Cleanup: if the project uses **`on_done`** cleanup policy, the control plane tears down after **done**/**cancelled**; otherwise remove worktrees with `git worktree remove` or run your own teardown script.

## Wording and advanced vs normal

- Use one consistent term in the UI: "isolated execution workspace" (or "isolated issue checkout" where that phrase is already used). Tooltips should explain that the issue gets a dedicated branch and worktree and that provision runs in that worktree.
- Project: enable/disable and default mode are main controls; base ref, branch template, worktree parent dir, provision/teardown are advanced.
- Issue: workspace mode toggle is main when the project has execution workspace enabled.
- Agent/runtime: runtime services JSON stays advanced-only.

## Re-enable plan

When this is ready to ship:

- re-enable the gated UI sections in the files above
- review wording and defaults for project and issue controls
- decide which agent/runtime settings should remain advanced-only
- add end-to-end product-level verification for the full UI workflow

## Related

For deployment of workers and workspace layout on k3s, see [K3S-LLM-DEPLOYMENT.md](../K3S-LLM-DEPLOYMENT.md).
