# Threat model: plugin host and third-party code

## Assets

- Company data reachable through board APIs and worker-mediated APIs.
- Secrets and adapter configuration.
- Plugin host RPC (`/api/internal/plugin-host/rpc`) and per-instance RPC tokens stored hashed in `plugin_instances.rpc_token_hash`.

## Trust boundaries

- **Board session / API keys** → company-scoped HTTP routes (`plugins:manage` for lifecycle).
- **Worker JWT** → `worker-api` only; plugin tool catalog is read-only discovery.
- **Plugin process** → must not receive DB superuser credentials; talks to host via Bearer secret (`HIVE_PLUGIN_HOST_SECRET`) plus per-instance token (rotation on re-register) in hardened deployments.

## Threats and mitigations

| Threat | Mitigation |
|--------|------------|
| Confused deputy on host RPC | Every method checks **declared capabilities** (`capabilities_json`); start with allowlisted methods (`ping` requires `rpc.ping`). |
| Privilege escalation via manifest | Manifest validated with `@hive/plugin-sdk`; capabilities intersect operator grant at registration time (stored JSON). |
| SSRF from plugins | No raw URL fetch in v1 host RPC; network egress must stay in supervised worker with allowlists (future). |
| Token theft | RPC uses TLS in production; rotate `rpc_token_hash` on re-install; separate `HIVE_PLUGIN_HOST_SECRET` from internal operator secret. |
| Cross-company data leak | Plugin instances are **deployment-scoped**; worker catalog resolves via company → `deployment_id`. Re-validate company on any future host API that accepts `companyId`. |

## Roadmap

- Spawn OOP workers with cgroup/resource limits; structured logs with `plugin_instance_id`.
- mTLS or local socket pairing instead of shared host secret where multiple co-tenants exist.
- Signature verification on `plugin_packages` artifacts.
