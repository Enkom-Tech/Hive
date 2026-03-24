---
title: Secrets Management
summary: Providers, strict mode, and automatic migration
---

Hive supports multiple secret backends and can migrate existing secrets from `local_encrypted` to `vault` (Vault/OpenBao KV v2) while preserving secret IDs referenced by agents.

## Scale ladder

- **Solo / small setup:** `local_encrypted`
- **Production team setup:** `local_encrypted` + `HIVE_SECRETS_STRICT_MODE=true`
- **Enterprise / multi-team:** `vault` (Vault or OpenBao KV v2)
- **Cloud-native target:** `aws_secrets_manager` / `gcp_secret_manager`

## Provider: `local_encrypted`

Local secrets are encrypted with AES-256-GCM using a local master key stored at:

```
~/.hive/instances/default/secrets/master.key
```

This key is auto-created during onboarding. The key never leaves your machine.

## Provider: `vault` (Vault / OpenBao KV v2)

The `vault` provider writes secret values to KV v2 and stores only provider metadata in Hive DB (`scheme`, mount/path/version), not plaintext.

Required settings:

- `HIVE_VAULT_ADDR` (or `VAULT_ADDR`)
- `HIVE_VAULT_TOKEN` (or `VAULT_TOKEN`)

Optional settings:

- `HIVE_VAULT_NAMESPACE` (or `VAULT_NAMESPACE`)
- `HIVE_VAULT_KV_MOUNT` (default: `hive`)

## Configuration

### CLI Setup

Onboarding writes default secrets config:

```sh
pnpm hive onboard
```

Update secrets settings:

```sh
pnpm hive configure --section secrets
```

Validate secrets config:

```sh
pnpm hive doctor
```

### Environment Overrides

| Variable | Description |
|----------|-------------|
| `HIVE_SECRETS_PROVIDER` | Default provider for new secrets (`local_encrypted` or `vault`) |
| `HIVE_SECRETS_MASTER_KEY` | 32-byte key as base64, hex, or raw string |
| `HIVE_SECRETS_MASTER_KEY_FILE` | Custom key file path |
| `HIVE_SECRETS_STRICT_MODE` | Set to `true` to enforce secret refs |
| `HIVE_VAULT_ADDR` | Vault/OpenBao base URL |
| `HIVE_VAULT_TOKEN` | Vault/OpenBao auth token |
| `HIVE_VAULT_NAMESPACE` | Vault namespace |
| `HIVE_VAULT_KV_MOUNT` | KV v2 mount path (default: `hive`) |

## Strict Mode

When strict mode is enabled, sensitive env keys (matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

```sh
HIVE_SECRETS_STRICT_MODE=true
```

Recommended for any deployment beyond local trusted.

## Automatic provider migration

Use the CLI to preview and apply migration from `local_encrypted` to `vault`:

```sh
hive secret migrate-provider --target-provider vault --dry-run --company-id <company-id>
hive secret migrate-provider --target-provider vault --apply --company-id <company-id>
```

You can scope to specific secrets:

```sh
hive secret migrate-provider \
  --target-provider vault \
  --apply \
  --company-id <company-id> \
  --secret-ids <secret-id-1>,<secret-id-2>
```

### What migration does

1. Reads all versions for each selected secret.
2. Resolves plaintext via the source provider.
3. Writes each version to Vault/OpenBao KV v2.
4. Updates Hive DB rows in-place (`provider`, `externalRef`, and version `material` metadata).

Because migration is in-place, existing `secret_ref.secretId` links stay valid in:

- `agents.adapter_config`
- `approvals.payload` (agent hire payloads)
- `invites.defaults_payload`
- `join_requests.agent_defaults_payload`

### Failure behavior and rollback

- If Vault writes fail, DB rows are unchanged.
- If Vault writes succeed but DB update fails, Vault may contain orphaned versions.
- Recovery path: fix root cause, re-run migration for the same secret IDs. Paths are deterministic, so retries are safe.
- Cleanup path for orphaned data: remove the affected KV path under your configured mount if migration was not committed.

## Secret references in agent config

Agent environment variables use secret references:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

The server resolves these at runtime and injects plaintext values into the agent process environment.
