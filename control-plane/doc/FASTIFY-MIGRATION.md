# Fastify Migration

Migration of `control-plane/server` from Express 5 to Fastify 5.

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
- Fastify ships pino as a first-class logger; removes the `pino-http` dependency.
- Fastify's schema-first design and type-provider model gives tighter TS inference on request/response shapes.
- `ws` WebSocket servers (`noServer: true`) attach to the raw `http.Server` and are framework-agnostic — they do not change.

## Package changes

| Removed | Added | Notes |
|---------|-------|-------|
| `express` | `fastify` | core |
| `cors` | `@fastify/cors` | parity |
| `helmet` | `@fastify/helmet` | parity |
| `express-rate-limit` | `@fastify/rate-limit` | parity |
| `multer` | `@fastify/multipart` | uploads |
| `pino-http` | fastify built-in | pino native |
| `supertest` | `fastify.inject()` | test transport |
| — | `@fastify/middie` | Vite Connect bridge in dev |
| — | `@fastify/static` | replaces `express.static` |

## Migration phases

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Baseline recorded (this document) | done |
| 1 | Fastify scaffold + env flag | pending |
| 2 | Global middleware port | pending |
| 3 | Route domain migration | pending |
| 4 | Vite dev + static | pending |
| 5 | Express removal | pending |
| 6 | Hardening + coverage lift | pending |

## Invariants (must hold at every phase boundary)

- `pnpm test:run` exits 0.
- `pnpm -r typecheck` exits 0.
- WebSocket upgrade paths (`/api/workers/link`, `/api/companies/:id/events/ws`) are unaffected.
- Security headers (CSP nonce, Helmet, Permissions-Policy, CORS) verified by `security-headers.test.ts`.
- Coverage does not regress below current thresholds (lines 32%, functions 29%).
