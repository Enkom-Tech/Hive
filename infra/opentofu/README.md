# OpenTofu reference for Hive

This folder is a reference starting point for operators that manage Hive infrastructure with OpenTofu.

## Scope

- This is an operator-facing infrastructure reference.
- Hive runtime integration for secrets lives in the control-plane app (`vault` provider).
- OpenTofu is optional and not required for local or small-team deployments.

## Recommended baseline

1. Provision OpenBao (or Vault) with TLS enabled.
2. Create a KV v2 mount for Hive (default mount name: `hive`).
3. Issue an auth token with minimum required policy for:
   - `create`, `update`, `read` on `hive/data/companies/*`
4. Inject runtime env vars for Hive:
   - `HIVE_SECRETS_PROVIDER=vault`
   - `HIVE_VAULT_ADDR=https://<vault-or-openbao-host>`
   - `HIVE_VAULT_TOKEN=<token>`
   - `HIVE_VAULT_KV_MOUNT=hive`
   - optional: `HIVE_VAULT_NAMESPACE=<namespace>`

## Example module split

- `network/`: private network and load balancer
- `vault/`: OpenBao/Vault deployment and policies
- `hive/`: Hive service deployment and env wiring

Keep credentials out of state where possible, and prefer secret injection from your runtime platform.
