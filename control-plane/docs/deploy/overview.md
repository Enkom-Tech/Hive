---
title: Deployment Overview
summary: Deployment modes at a glance
---

Hive supports three deployment configurations, from zero-friction local to internet-facing production.

## Deployment Modes

| Mode | Auth | Best For |
|------|------|----------|
| `local_trusted` | No login required | Single-operator local machine |
| `authenticated` + `private` | Login required | Private network (Tailscale, VPN, LAN) |
| `authenticated` + `public` | Login required | Internet-facing cloud deployment |

## Quick Comparison

### Local Trusted (Default)

- Loopback-only host binding (localhost)
- No human login flow
- Fastest local startup
- Best for: solo development and experimentation

### Authenticated + Private

- Login required via Better Auth
- Binds to all interfaces for network access
- Auto base URL mode (lower friction)
- Best for: team access over Tailscale or local network

### Authenticated + Public

- Login required
- Explicit public URL required
- Stricter security checks
- Best for: cloud hosting, internet-facing deployment

## Choosing a Mode

- **Just trying Hive?** Use `local_trusted` (the default)
- **Sharing with a team on private network?** Use `authenticated` + `private`
- **Deploying to the cloud?** Use `authenticated` + `public`

Set the mode during onboarding:

```sh
pnpm hive onboard
```

Or update it later:

```sh
pnpm hive configure --section server
```

## High availability (API replicas + managed workers)

With **more than one** control-plane API replica, WebSocket connections for `hive-worker` land on arbitrary instances. Set **`HIVE_WORKER_DELIVERY_BUS_URL`** to a shared **Redis-protocol** service (Redis, Dragonfly, Valkey, or compatible) so run/cancel payloads can reach the replica that holds the socket (see `doc/adr/003-unified-managed-worker-links.md`). Single-replica installs can omit the bus.

For where to run workers (VPS, Docker, Kubernetes, air-gap) and how those paths map to one contract, see [Worker (drone) deployment matrix](./worker-deployment-matrix.md).
