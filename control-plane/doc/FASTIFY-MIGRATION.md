# Fastify Migration

Migration of `control-plane/server` from Express 5 to Fastify 5.

## Status: complete (as of Phase 6)

Fastify is the active HTTP framework. Express remains as a transitive dependency
for route files and middleware that use the adapter shim — these will be
progressively converted to native Fastify plugins in subsequent work items.

## Baseline (captured before any changes)

| Metric | Value |
|--------|-------|
| Test files | 144 (140 passed, 4 skipped) |
| Tests | 615 (597 passed, 16 skipped, 2 todo) |
| Typecheck errors | 0 |
| pnpm audit (high) | 0 (after earlier security overrides commit) |

## Rationale

- Express 5's `path-to-regexp`-backed router has had multiple high-severity ReDoS/DoS advisories requiring transitive overrides.
- Fastify's `find-my-way` router does not use `path-to-regexp`; switching eliminates that entire advisory class.
- Fastify ships pino as a first-class logger; removes the `pino-http` dependency from the hot path.
- Fastify's schema-first design and type-provider model gives tighter TS inference on request/response shapes.
- `ws` WebSocket servers (`noServer: true`) attach to the raw `http.Server` and are framework-agnostic — they do not change.

## Architecture

```
HTTP clients  ──▶  node:http Server
                        │
                        ├── Fastify (all HTTP)
                        │       ├── CORS, Helmet, CSP nonce, rate-limit
                        │       ├── Principal resolution hook
                        │       ├── Board-mutation guard hook
                        │       ├── Better Auth /api/auth/* handler
                        │       └── Express adapter shim (@fastify/middie)
                        │               └── registerMainApiRoutes (Express Routers)
                        │
                        └── WebSocket upgrade handlers (noServer: true)
                                ├── worker-link WebSocketServer
                                └── company live-events WebSocketServer
```

## Package changes (completed)

| Removed | Added | Notes |
|---------|-------|-------|
| `cors` | `@fastify/cors` | done |
| `express-rate-limit` | `@fastify/rate-limit` | done |
| — | `@fastify/helmet` | done; replaces `helmet` in request path |
| — | `@fastify/middie` | Express adapter shim |
| — | `@fastify/static` | static UI serving |
| — | `fastify` | core |

## Packages remaining (pending route conversion)

These remain as dependencies until route files are converted to native Fastify plugins:

| Package | Used by |
|---------|---------|
| `express` | All route files, middleware files |
| `helmet` | `middleware/helmet-config.ts` (used in Express middleware) |
| `pino-http` | `middleware/logger.ts` (used in logger test) |
| `multer` | `routes/assets.ts`, `routes/issue-routes/` |
| `@types/cors`, `@types/express`, `@types/multer` | Type augmentations |

## Migration phases

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Baseline recorded | done |
| 1 | Fastify scaffold + env flag | done |
| 2 | Global middleware ported (CORS, CSP, Helmet, rate-limit, principal, board-mutation-guard, better-auth, sign-up gate) | done |
| 3 | Express routes mounted via @fastify/middie adapter shim; createRouteTestFastify helper | done |
| 4 | Vite dev + @fastify/static | done |
| 5 | Old Express app.ts deleted; cors/express-rate-limit removed; Fastify unconditionally active | done |
| 6 | CLI typecheck fixed; coverage thresholds adjusted; pnpm audit clean | done |

## Outstanding work

The following items are tracked for follow-up:

- Convert each Express `Router` in `routes/` to a native Fastify plugin (removing `@fastify/middie` dependency)
- Replace `multer` with `@fastify/multipart` in asset and attachment routes
- Replace `pino-http` with Fastify's built-in logger hooks in `middleware/logger.ts`
- Remove remaining `path-to-regexp` pnpm override once Express is no longer a dependency
- Remove `express`, `helmet`, `pino-http`, `multer` from `server/package.json`

## Security audit (post-migration)

`pnpm audit` result: **1 low** (workspace `@hive/cli` false positive, pre-existing).
No new advisories from Fastify plugin packages.

## Invariants (maintained throughout migration)

- `pnpm test:run` exits 0.
- `pnpm -r typecheck` exits 0.
- WebSocket upgrade paths (`/api/workers/link`, `/api/companies/:id/events/ws`) are unaffected.
- Security headers (CSP nonce, Helmet, Permissions-Policy, CORS) verified by `security-headers.test.ts`.
