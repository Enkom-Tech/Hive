---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm hive issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm hive issue get <issue-id-or-identifier>

# Create issue
pnpm hive issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm hive issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm hive issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm hive issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm hive issue release <issue-id>
```

## Company Commands

```sh
pnpm hive company list
pnpm hive company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm hive company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm hive company import \
  --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# Apply import
pnpm hive company import \
  --from ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm hive agent list
pnpm hive agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm hive approval list [--status pending]

# Get approval
pnpm hive approval get <approval-id>

# Create approval
pnpm hive approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm hive approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm hive approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm hive approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm hive approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm hive approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm hive activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm hive dashboard get
```

## Heartbeat

```sh
pnpm hive heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
