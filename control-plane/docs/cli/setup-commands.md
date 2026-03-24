---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `hive run`

One-command bootstrap and start:

```sh
pnpm hive run
```

Does:

1. Auto-onboards if config is missing
2. Runs `hive doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm hive run --instance dev
```

## `hive onboard`

Interactive first-time setup:

```sh
pnpm hive onboard
```

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm hive onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm hive onboard --yes
```

## `hive doctor`

Health checks with optional auto-repair:

```sh
pnpm hive doctor
pnpm hive doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `hive configure`

Update configuration sections:

```sh
pnpm hive configure --section server
pnpm hive configure --section secrets
pnpm hive configure --section storage
```

## `hive env`

Show resolved environment configuration:

```sh
pnpm hive env
```

## `hive allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm hive allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.hive/instances/default/config.json` |
| Database | `~/.hive/instances/default/db` |
| Logs | `~/.hive/instances/default/logs` |
| Storage | `~/.hive/instances/default/data/storage` |
| Secrets key | `~/.hive/instances/default/secrets/master.key` |

Override with:

```sh
HIVE_HOME=/custom/home HIVE_INSTANCE_ID=dev pnpm hive run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm hive run --data-dir ./tmp/hive-dev
pnpm hive doctor --data-dir ./tmp/hive-dev
```
