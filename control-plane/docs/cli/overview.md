---
title: CLI Overview
summary: CLI installation and setup
---

The Hive CLI (invoked as `hive`) handles instance setup, diagnostics, and control-plane operations.

## Usage

```sh
pnpm hive --help
```

## Global Options

All commands support:

| Flag | Description |
|------|-------------|
| `--data-dir <path>` | Local Hive data root (isolates from `~/.hive`) |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API authentication token |
| `--context <path>` | Context file path |
| `--profile <name>` | Context profile name |
| `--json` | Output as JSON |

Company-scoped commands also accept `--company-id <id>`.

For clean local instances, pass `--data-dir` on the command you run:

```sh
pnpm hive run --data-dir ./tmp/hive-dev
```

## Context Profiles

Store defaults to avoid repeating flags:

```sh
# Set defaults
pnpm hive context set --api-base http://localhost:3100 --company-id <id>

# View current context
pnpm hive context show

# List profiles
pnpm hive context list

# Switch profile
pnpm hive context use default
```

To avoid storing secrets in context, use an env var:

```sh
pnpm hive context set --api-key-env-var-name HIVE_API_KEY
export HIVE_API_KEY=...
```

Context is stored at `~/.hive/context.json`.

## Command Categories

The CLI has two categories:

1. **[Setup commands](/cli/setup-commands)** — instance bootstrap, diagnostics, configuration
2. **[Control-plane commands](/cli/control-plane-commands)** — issues, agents, approvals, activity
