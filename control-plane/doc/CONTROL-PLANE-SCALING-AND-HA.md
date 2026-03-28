# Control plane scaling and high availability

This document describes **current deployment assumptions** for the Hive control-plane Node process and what must change before running **multiple API replicas** or treating the stack as highly available.

## Single-process assumptions (today)

The API server is designed to run as **one Node process** (optionally behind a reverse proxy). Several subsystems keep state **in memory** inside that process:

| Subsystem | Location | Impact if you add a second replica |
|-----------|----------|-----------------------------------|
| Storage service cache | `server/src/storage/index.ts` | Cached clients may diverge; prefer injecting storage per request/tests. |
| Run log store | `server/src/services/run-log-store.ts` | Log handles and buffers are not shared across replicas. |
| Live events (SSE / in-process emitters) | `server/src/services/live-events.ts` | Subscribers on replica A do not see events published on replica B. |
| Board claim / challenge state | `server/src/board-claim.ts` | Challenge flow assumes a single authoritative holder of `activeChallenge`. |
| Placement / Prometheus init | `server/src/placement-metrics.ts` (via `app.ts`) | Metrics registry is process-local. |
| Plugin supervisor runtime | `server/src/services/plugin-supervisor.ts` | Supervised children are bound to one process. |
| Workspace runtime services | `server/src/services/workspace-runtime/` | Local-process runtime services and leases are in-memory maps. |

Until these are backed by shared infrastructure (or the product explicitly documents **single-replica-only** deployments), **do not** scale the API horizontally without addressing the corresponding subsystem.

## Worker WebSocket delivery across replicas

When the worker connects to the control plane over WebSocket, run messages must reach the process that holds that socket. For **multiple API replicas**, set:

- `HIVE_WORKER_DELIVERY_BUS_URL` — Redis-protocol pub/sub bus (see `server/src/workers/worker-delivery-redis.ts` and config in `server/src/config.ts`).

With a single replica, omit this variable; delivery stays local.

## CLI and separate server processes

For packaging isolation, `hive run` can start the published server **`dist/index.js`** in a **child process** instead of loading `@hive/server` in-process.

- `HIVE_CLI_SERVER_SUBPROCESS=1` (or `true`) — always use subprocess when `dist/index.js` exists (same requirements as below).
- `HIVE_CLI_SERVER_SUBPROCESS=0` (or `false`) — always use in-process `startServer()` (monorepo dev entry or dynamic `import("@hive/server")`).
- **Unset (default):** use subprocess **automatically** when a published `dist/index.js` is resolvable **and** Postgres is configured (`database.connectionString` or `DATABASE_URL`), and the CLI is **not** running from a checkout that still has `server/src/index.ts` (monorepo dev stays in-process).

Subprocess mode requires **Postgres**; embedded Postgres is not supported there because the parent CLI does not share the child’s embedded DB lifecycle.

## Test coverage thresholds

Root `vitest.config.ts` still merges coverage across server, CLI, UI, and packages for optional full-repo reports (`pnpm test:coverage`), without global thresholds.

**Server-only gate:** `server/vitest.config.ts` sets `root` to the server package, runs `src/**/*.test.ts` (and `*.spec.ts`), and enforces v8 **coverage thresholds** on `server/src/**/*.ts` only. CI runs `pnpm test:run` (all Vitest projects) then `pnpm test:coverage:server`. Reports are written under `coverage-server/`. Ratchet thresholds upward slowly when you add tests in a subsystem you own; keep them below the aggregate line rate until the server suite grows.

## Related reading

- `doc/MANAGED-WORKER-ARCHITECTURE.md` — worker / control-plane WebSocket contract.
- `doc/K3S-LLM-DEPLOYMENT.md` — example cluster deployment and observability.
