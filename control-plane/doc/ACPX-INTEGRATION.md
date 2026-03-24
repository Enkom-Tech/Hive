# acpx integration (worker)

This document defines how the Hive worker integrates [acpx](https://github.com/openclaw/acpx) so runs can use the Agent Client Protocol (ACP) for Codex, Claude, and other ACP-compatible agents.

## Scope

- **Worker-side only.** The control plane WebSocket contract (run, cancel, status, log) is unchanged. Only the worker gains a new executor type and optional `adapterKey` handling.
- The control plane continues to send `run` with `runId`, `agentId`, and `context`; it may send optional `adapterKey` to select an ACP executor.

## Context contract

For runs that use an ACP adapter key (e.g. `codex_acp`, `claude_acp`), the worker expects the run `context` (JSON) to include a string field that becomes the acpx prompt:

- **Fields:** `prompt` or `instruction` (string). The worker uses the first non-empty value.
- **Max length:** 256 KB (262144 bytes). Longer values are rejected with an error.
- **Encoding:** UTF-8. Invalid UTF-8 is rejected.
- **Secrets:** Context is task payload only. The control plane must not put API keys, tokens, or other secrets in context. The worker does not pass control-plane credentials to acpx.

The control plane must set `context.prompt` or `context.instruction` when dispatching a run to an ACP adapter key (e.g. derived from issue title/description, task summary, or a template).

When the control plane uses execution-workspace policy (e.g. `git_worktree`), it sets **context.hiveWorkspace** (`cwd`, `worktreePath`, `branchName`, etc.). The worker passes the full context to acpx (e.g. via `HIVE_CONTEXT_JSON`). The **worker does not set** the process working directory from `context.hiveWorkspace`; see [DRONE-SPEC.md](DRONE-SPEC.md) for the run message and workspace behavior. The agent sees the intended path in context but the acpx process runs in the drone's `HIVE_WORKSPACE` unless the run payload is extended with a workspace path used by the drone.

## Adapter model

Operators configure ACP-backed adapters via environment variables. The registry builds an `AcpxExecutor` when both are set for a key:

- `HIVE_ADAPTER_<key>_CMD` — command or path for acpx (e.g. `acpx` or `npx acpx`). If `HIVE_ADAPTER_<key>_URL` is set, the provisioned path is used instead.
- `HIVE_ADAPTER_<key>_AGENT` — acpx agent name (e.g. `codex`, `claude`).

Example: `codex_acp` and `claude_acp`:

- `HIVE_ADAPTER_codex_acp_CMD=acpx`, `HIVE_ADAPTER_codex_acp_AGENT=codex`
- `HIVE_ADAPTER_claude_acp_CMD=acpx`, `HIVE_ADAPTER_claude_acp_AGENT=claude`

The control plane (or run request) sends `adapterKey: "codex_acp"` or `"claude_acp"` to use the ACP path. Command and agent name come only from operator env; never from the run payload or context.

## Security

- **Prompt:** Taken only from context; validated (max length, UTF-8); passed to acpx as a single argument (no shell).
- **Invocation:** Worker uses `exec` with argv; no shell so no injection from context.
- **Secrets:** Worker holds control-plane credentials; only HIVE_* env (e.g. `HIVE_AGENT_ID`, `HIVE_RUN_ID`, `HIVE_CONTEXT_JSON`, `HIVE_WORKSPACE`) are passed to acpx.
- **Allowlist:** Command and agent name come only from operator-configured env; never from context or run payload.
- **Provisioning:** When `HIVE_ADAPTER_<key>_URL` is set, use HTTPS only and optional `HIVE_ADAPTER_<key>_SHA256` for verification.
- **Container:** Optional per-adapter container (`HIVE_ADAPTER_<key>_CONTAINER` + `_IMAGE`) applies to AcpxExecutor the same way (workspace mount, same env rules).

## Isolation (autosandbox)

Autosandbox is in scope for ACP runs: the same policy-driven model as in [DRONE-SPEC.md](DRONE-SPEC.md) §5 (default-on, allowlisted images only, control plane decides / drone enforces). When a container or sandbox is used for ACP adapters, it follows the same allowlist and policy rules. See DRONE-SPEC §5 "Per-run container or sandbox" for target behavior and current implementation.

## Deployment and runtime availability

The default worker image (distroless) does **not** include Node or acpx. To use ACP adapters, either (a) use a worker image variant that includes Node and acpx (preinstalled at build time), or (b) pre-install acpx on the host or in the environment where the worker runs, or (c) use URL-based provisioning only if a single-binary or archive artifact for acpx is available (the current drone provisioner does not run npm). For zero-config ACP, use an image that ships with acpx and preconfigured adapter keys (e.g. `codex_acp`, `claude_acp`), or document the one-time setup (install acpx, set env) for the operator. See [DRONE-SPEC.md](DRONE-SPEC.md) §4 and "Who provides runtimes" for the general model.

## Rollback

Existing adapter keys (e.g. `codex`, `claude` without ACP) are unchanged. ACP is opt-in via separate keys (e.g. `codex_acp`). Operators can keep using non-ACP adapters; no migration required.

## References

- [DRONE-SPEC.md](DRONE-SPEC.md) — run message `adapterKey`, execution adapters, provisioning.
- [MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) — worker and control plane roles.
