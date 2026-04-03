# Execution workspace and remote managed workers

Isolated execution workspaces often use a **git worktree** on the **same machine as the control plane** (`workspace-runtime` under the project repo). A **managed worker** on another host receives `context.hiveWorkspace.cwd` / `worktreePath` in the run payload; those paths are meaningless on the drone unless that host shares the same filesystem.

## Decision tree

1. **Worker runs on the same host as the control plane** (or the repo is on shared storage mounted at the same path)  
   - Git worktree isolation works as implemented.

2. **Worker runs remotely** (typical VPS / pool drone)  
   - **Do not** rely on control-plane-local worktree paths. Options:
     - **Colocate** clone: run the worker on a host that has the repository checked out and align `HIVE_WORKSPACE` / project workspace `cwd` with that layout.
     - **Worker materialization**: enable worker-side clone/fetch (`HIVE_WORKSPACE_MATERIALIZE_ENABLED` and `hiveWorkspaceMaterialize` in run context when the product emits it). See [ADR 007](../../doc/adr/007-remote-execution-workspace.md) and [issue-worktree-support.md](../../doc/experimental/issue-worktree-support.md).
     - **Artifact-based workspace**: worker fetches a signed archive before run (`HIVE_WORKSPACE_ARTIFACT_FETCH_ENABLED` and artifact fields in context) when supported by your deployment.

3. **Fail fast during rollout**  
   - Set **`HIVE_WORKSPACE_REMOTE_EXEC_GUARD=true`** on the API. Heartbeat will **fail** runs that use a **`git_worktree`** strategy with a non-null `worktreePath`, so you do not silently schedule impossible paths to remote drones. Turn this off only when you know all workers can see those paths.

## Related

- [worker-deployment-matrix.md](./worker-deployment-matrix.md) — where workers run  
- [DRONE-SPEC.md](../../doc/DRONE-SPEC.md) §10 — workspace row  
