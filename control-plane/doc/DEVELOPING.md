# Developing

Hive is a control plane for agentic companies. This project can run fully in local dev without setting up PostgreSQL manually.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- Pull request CI validates dependency resolution when manifests change.
- Pushes to `master` regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only --no-frozen-lockfile`, commit it back if needed, and then run verification with `--frozen-lockfile`.

## Tests

From `control-plane`, run `pnpm test:run` or `pnpm test:coverage`. The worker delivery pub/sub smoke test (`server/src/__tests__/worker-delivery-redis.integration.test.ts`) is skipped unless **`HIVE_WORKER_DELIVERY_PUBSUB_TEST_URL`** is set (for example `redis://127.0.0.1:6379` with Redis running locally). CI provides Redis and sets that variable automatically.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- API server: `http://localhost:3100`
- UI: served by the API server in dev middleware mode (same origin as API)

`pnpm dev` runs the server with Node.js `--watch`, `--watch-path` scoped to `server/src` and workspace package sources (not `ui`), and `tsx` for TypeScript execution. Use `pnpm dev:once` to run without file watching.

Tailscale/private-auth dev mode:

```sh
pnpm dev --tailscale-auth
```

This runs dev as `authenticated/private` and binds the server to `0.0.0.0` for private-network access.

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
pnpm hive allowed-hostname dotta-macbook-pro
```

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm hive run
```

`hive run` does:

1. auto-onboard if config is missing
2. `hive doctor` with repair enabled
3. starts the server when checks pass

**Packaging:** For published installs with Postgres, the CLI can start the API in a **child process** (`dist/index.js`) instead of loading `@hive/server` in-process. See `doc/CONTROL-PLANE-SCALING-AND-HA.md` (`HIVE_CLI_SERVER_SUBPROCESS`, default heuristics). Monorepo `pnpm dev` / checkout with `server/src` stays in-process for ergonomics.

## Docker Quickstart (No local Node install)

Build and run Hive in Docker:

```sh
docker build -t hive-local .
docker run --name hive \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e HIVE_HOME=/hive \
  -v "$(pwd)/data/docker-hive:/hive" \
  hive-local
```

Or use Compose:

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.hive/instances/default/db` (or `%USERPROFILE%\.hive\instances\default\db` on Windows)

Hive uses the `HIVE_*` prefix for environment variables (e.g. `HIVE_HOME`, `HIVE_CONFIG`, `HIVE_AGENT_JWT_SECRET`). The default data directory is `~/.hive` (or `%USERPROFILE%\.hive` on Windows). When both `HIVE_*` and legacy names are set, `HIVE_*` wins.

Override home and instance:

```sh
HIVE_HOME=/custom/path HIVE_INSTANCE_ID=dev pnpm hive run
```

No Docker or external database is required for this mode.

To re-run the Get Started onboarding (e.g. after testing the setup flow), either:

- **Reset embedded DB:** Remove the instance DB directory (e.g. `~/.hive/instances/default/db` on Unix, or `%USERPROFILE%\.hive\instances\default\db` on Windows), then start the server again. The app will create a fresh DB and show onboarding when there are no companies.
- **Delete the company:** Use the API or UI to delete the company you created so that no companies remain; then open the dashboard and use "Get Started" (or refresh so onboarding opens automatically when `companies.length === 0`).

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.hive/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm hive configure --section storage
```

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Hive falls back to an agent home workspace under the instance root:

- `~/.hive/instances/default/workspaces/<agent-id>`

This path honors `HIVE_HOME` (or `HIVE_HOME`) and `HIVE_INSTANCE_ID` in non-default setups.

## Worktree-local Instances

When developing from multiple git worktrees, do not point two Hive servers at the same embedded PostgreSQL data directory.

Instead, create a repo-local Hive config plus an isolated instance for the worktree:

```sh
hive worktree init
# or create the git worktree and initialize it in one step:
pnpm hive worktree:make hive-pr-432
```

This command:

- writes repo-local files at `.hive/config.json` and `.hive/.env`
- creates an isolated instance under `~/.hive-worktrees/instances/<worktree-id>/`
- when run inside a linked git worktree, mirrors the effective git hooks into that worktree's private git dir
- picks a free app port and embedded PostgreSQL port
- by default seeds the isolated DB in `minimal` mode from your main instance via a logical SQL snapshot

Seed modes:

- `minimal` keeps core app state like companies, projects, issues, comments, approvals, and auth state, preserves schema for all tables, but omits row data from heavy operational history such as heartbeat runs, wake requests, activity logs, runtime services, and agent session state
- `full` makes a full logical clone of the source instance
- `--no-seed` creates an empty isolated instance

After `worktree init`, both the server and the CLI auto-load the repo-local `.hive/.env` when run inside that worktree, so normal commands like `pnpm dev`, `hive doctor`, and `hive db:backup` stay scoped to the worktree instance.

That repo-local env also sets `HIVE_IN_WORKTREE=true`, which the server can use for worktree-specific UI behavior such as an alternate favicon.

Print shell exports explicitly when needed:

```sh
hive worktree env
# or:
eval "$(hive worktree env)"
```

### Worktree CLI Reference

**`pnpm hive worktree init [options]`** — Create repo-local config/env and an isolated instance for the current worktree.

| Option | Description |
|---|---|
| `--name <name>` | Display name used to derive the instance id |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.hive-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source HIVE_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
hive worktree init --no-seed
hive worktree init --seed-mode full
hive worktree init --from-instance default
hive worktree init --from-data-dir ~/.hive
hive worktree init --force
```

**`pnpm hive worktree:make <name> [options]`** — Create `~/NAME` as a git worktree, then initialize an isolated Hive instance inside it. This combines `git worktree add` with `worktree init` in a single step.

| Option | Description |
|---|---|
| `--start-point <ref>` | Remote ref to base the new branch on (e.g. `origin/main`) |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.hive-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source HIVE_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
pnpm hive worktree:make hive-pr-432
pnpm hive worktree:make my-feature --start-point origin/main
pnpm hive worktree:make experiment --no-seed
```

**`pnpm hive worktree env [options]`** — Print shell exports for the current worktree-local Hive instance.

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `--json` | Print JSON instead of shell exports |

Examples:

```sh
pnpm hive worktree env
pnpm hive worktree env --json
eval "$(pnpm hive worktree env)"
```

For project execution worktrees, Hive can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree and receives `HIVE_WORKSPACE_*`, `HIVE_PROJECT_ID`, `HIVE_AGENT_ID`, and `HIVE_ISSUE_*` environment variables so each repo can bootstrap itself however it wants.

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array
- `GET /api/releases/check` returns `{ currentVersion, latestVersion?, releasesUrl? }` for the update-available banner. Override with `HIVE_RELEASES_REPO=owner/repo` or set `HIVE_UPDATE_CHECK_DISABLED=1` to disable the check.

Instance operators (board) can open **Instance → Status** in the UI, which calls `GET /api/instance/status` for version, migration state, scheduler summary, and (for instance admins) workload hotspots. Applying migrations from the UI is restricted to **instance admins** and is off by default in authenticated deployments: set `HIVE_UI_MIGRATIONS_ENABLED=1` to allow `POST /api/instance/migrations/apply`. When unset, UI apply defaults to **on** only for `local_trusted`. Production should still prefer `pnpm db:migrate` or release automation.

Notable company-scoped endpoints (require auth and a valid `companyId`):

- `GET /api/companies/:companyId/dashboard` — dashboard summary (agents, tasks, costs, approvals, stale count).
- `GET /api/companies/:companyId/events` — Server-Sent Events (SSE) stream for broad real-time updates: activity, heartbeat run state, and agent lifecycle events for that company. Use for live UIs without polling. (The worker's connection to the control plane is a separate WebSocket link for run/cancel/status/log; see §11 in SPEC-implementation.)
- `GET /api/companies/:companyId/workload` — workload/capacity metrics and throttle recommendation (`normal` | `throttle` | `shed` | `pause`). Agents and gateways can poll this to back off when the system is under load. See §10.8.2 in `doc/SPEC-implementation.md` and env vars `HIVE_WORKLOAD_*`.

## Reset Local Dev Database

To wipe local dev data and start fresh:

```sh
rm -rf ~/.hive/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Automatic DB Backups

Hive can run automatic DB backups on a timer. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.hive/instances/default/data/backups`

Configure these in:

```sh
pnpm hive configure --section database
```

Run a one-off backup manually:

```sh
pnpm hive db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `HIVE_DB_BACKUP_ENABLED=true|false`
- `HIVE_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `HIVE_DB_BACKUP_RETENTION_DAYS=<days>`
- `HIVE_DB_BACKUP_DIR=/absolute/or/~/path`

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.hive/instances/default/secrets/master.key`
- Override key material directly: `HIVE_SECRETS_MASTER_KEY`
- Override key file path: `HIVE_SECRETS_MASTER_KEY_FILE`

Strict mode (recommended outside local trusted machines):

```sh
HIVE_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

CLI configuration support:

- `pnpm hive onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm hive configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm hive doctor` validates secrets adapter configuration and can create a missing local key file with `--repair`.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
HIVE_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Hive CLI (invoked as `hive` or `pnpm hive`) includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm hive issue list --company-id <company-id>
pnpm hive issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm hive issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm hive context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm hive issue list
pnpm hive dashboard get
```

See full command reference in `doc/CLI.md`.

## Optional security and join behaviour

Target is managed worker only; see `doc/SPEC-implementation.md` and `doc/DRONE-SPEC.md` for worker/drone env and configuration.

## OpenClaw Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/hive` returns the Hive heartbeat skill markdown (legacy path name).

## Agent onboarding

Smoke scripts for the legacy OpenClaw gateway have been removed. Agent onboarding is via the managed worker; see doc/MANAGED-WORKER-ARCHITECTURE.md.

## Syncing with upstream

To pull improvements from the upstream Hive repository (if applicable):

1. **One-time:** add the upstream remote (if not already added):
   ```sh
   git remote add upstream https://github.com/Enkom-Tech/Hive.git
   ```

2. **When you want to sync:** fetch and merge (or rebase) from upstream:
   ```sh
   git fetch upstream
   git merge upstream/master
   ```
   Use `upstream/main` if upstream’s default branch is `main`. Resolve conflicts keeping Hive branding and Hive-specific changes on our side; keep package names, env vars, and protocol identifiers from upstream.

3. Optionally document your branch strategy (e.g. merge upstream into `master` periodically).
