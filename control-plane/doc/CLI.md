# CLI Reference

Hive CLI (invoked as `hive` or `pnpm hive`) supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm hive --help
```

First-time local bootstrap + run:

```sh
pnpm hive run
```

Choose local instance:

```sh
pnpm hive run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `hive onboard` and `hive configure --section server` set deployment mode in config
- runtime can override mode with `HIVE_DEPLOYMENT_MODE`
- `hive run` and `hive doctor` do not yet expose a direct `--mode` flag

Target behavior (planned) is documented in `doc/DEPLOYMENT-MODES.md` section 5.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm hive allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.hive`:

```sh
pnpm hive run --data-dir ./tmp/hive-dev
pnpm hive issue list --data-dir ./tmp/hive-dev
```

## Context Profiles

Store local defaults in `~/.hive/context.json`:

```sh
pnpm hive context set --api-base http://localhost:3100 --company-id <company-id>
pnpm hive context show
pnpm hive context list
pnpm hive context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm hive context set --api-key-env-var-name HIVE_API_KEY
export HIVE_API_KEY=...
```

## Company Commands

```sh
pnpm hive company list
pnpm hive company get <company-id>
pnpm hive company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm hive company delete PAP --yes --confirm PAP
pnpm hive company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `HIVE_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `HIVE_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm hive issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm hive issue get <issue-id-or-identifier>
pnpm hive issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm hive issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm hive issue comment <issue-id> --body "..." [--reopen]
pnpm hive issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm hive issue release <issue-id>
```

## Agent Commands

```sh
pnpm hive agent list --company-id <company-id>
pnpm hive agent get <agent-id>
pnpm hive agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Hive agent:

- registers or binds worker credentials; the worker holds credentials and the CLI runs under the worker (no API key is given to the agent process)
- installs missing Hive skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `HIVE_API_URL`, `HIVE_COMPANY_ID`, `HIVE_AGENT_ID`, and worker credential env as applicable

Example for shortname-based local setup:

```sh
pnpm hive agent local-cli codexcoder --company-id <company-id>
pnpm hive agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm hive approval list --company-id <company-id> [--status pending]
pnpm hive approval get <approval-id>
pnpm hive approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm hive approval approve <approval-id> [--decision-note "..."]
pnpm hive approval reject <approval-id> [--decision-note "..."]
pnpm hive approval request-revision <approval-id> [--decision-note "..."]
pnpm hive approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm hive approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm hive activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm hive dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm hive heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Managed worker

Start the Go worker so the control plane can deliver runs over WebSocket (`/api/workers/link`). The CLI passes credentials to the worker as `HIVE_AGENT_KEY` (the worker binary reads that env). **Preferred:** a short-lived enrollment token from the board UI (`POST /api/agents/{id}/link-enrollment-tokens`):

```sh
export HIVE_WORKER_ENROLLMENT_TOKEN='<one-time-token>'
pnpm hive worker link --agent-id <agent-id> [--api-base http://localhost:3100]
# or: pnpm hive worker link --agent-id <id> --enrollment-token '<token>'
```

**Advanced:** long-lived plain API key via `HIVE_AGENT_KEY` or `--agent-key`.

Optional: `HIVE_WORKER_BIN` or `--worker-bin` for the binary; otherwise `hive-worker` on `PATH`, or `go run ./cmd/worker` when the repo contains `infra/worker`.

## Local Storage Defaults

Default local instance root is `~/.hive/instances/default`:

- config: `~/.hive/instances/default/config.json`
- embedded db: `~/.hive/instances/default/db`
- logs: `~/.hive/instances/default/logs`
- storage: `~/.hive/instances/default/data/storage`
- secrets key: `~/.hive/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
HIVE_HOME=/custom/home HIVE_INSTANCE_ID=dev pnpm hive run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm hive configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
