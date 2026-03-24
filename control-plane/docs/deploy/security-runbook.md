# Control plane security runbook

## Security headers

All responses (API and UI) send security headers via **Helmet** plus a small middleware that sets **Permissions-Policy**. A per-request **CSP nonce** is generated and used for `script-src` and `style-src`, so the app does not use `'unsafe-inline'`.

- **X-Content-Type-Options**, **X-Frame-Options**, **Referrer-Policy:** Set by Helmet (defaults).
- **Permissions-Policy:** Set by server middleware (geolocation, microphone, camera restricted).
- **Content-Security-Policy:** Set by Helmet with a **profile** chosen from how the UI is served:
  - **`strict`** (API-only / default in tests): `script-src` and `style-src` use a per-request nonce only (no `'unsafe-inline'`). Nonce is generated in `cspNonceMiddleware` before Helmet runs.
  - **`vite-dev`**: `script-src` includes `'unsafe-inline'` and `'unsafe-eval'`; `style-src` includes `'unsafe-inline'`; **`worker-src`** includes `'self'` and **`blob:`** so Vite’s client can create its HMR reconnect worker (otherwise CSP blocks `new Worker(blobURL)`). Needed for Vite’s dev pipeline and libraries such as **MDXEditor** (inline styles, occasional `eval` in dev). Browsers ignore `'unsafe-inline'` when a nonce is also present, so this profile does not mix nonces into those directives.
  - **`static-ui`** (built UI from `ui/dist`): `script-src` stays nonce-based; `style-src` adds `'unsafe-inline'` so MDXEditor and similar components work in production without weakening script execution.
  - The UI’s theme script in `index.html` uses `__CSP_NONCE__`, replaced per request where nonces apply. In **vite-dev middleware** mode, Vite uses `appType: "custom"` so Express owns `transformIndexHtml` (Vite’s default `spa` middleware would otherwise serve `index.html` from disk and skip Hive’s nonce pass). The server sets Vite’s `html.cspNonce` during `transformIndexHtml` and runs `ensureCspNonceOnScriptOpeningTags` when nonces are used. `connect-src` allows the Vite HMR server (`serverPort + 10000`, e.g. `ws://127.0.0.1:13100` when the API is on 3100) in dev.

## CORS

The server uses an allowlist for `Access-Control-Allow-Origin`. Only origins listed in `HIVE_CORS_ORIGINS` (comma-separated) are allowed; no origin is allowed when the env is unset or empty.

- **Set allowed origins:** `HIVE_CORS_ORIGINS=https://app.example.com,https://dashboard.example.com`
- **Same-origin only:** Omit `HIVE_CORS_ORIGINS` or set it empty so cross-origin requests are rejected.
- Credentials (cookies, auth headers) are supported for allowed origins.

## Rate limiting

- **General API:** `HIVE_RATE_LIMIT_WINDOW_MS` (default 900000 = 15 min) and `HIVE_RATE_LIMIT_MAX` (default 4000) limit requests per IP per window to `/api/*`. Rate limiting is **not** applied when `HIVE_DEPLOYMENT_MODE=local_trusted`, or when mode is `authenticated` and `HOST` is a loopback address (`127.0.0.1`, `localhost`, `::1`) — so typical local dev with the board UI does not hit 429 from polling.
- **Sensitive routes** (auth, key creation, invites) use a stricter limit (e.g. 30 per window) to reduce abuse. These paths include:
  - `/api/auth/*`
  - `POST /api/companies/:id/invites`
  - `POST /api/agents/:id/keys`
  - `POST /api/agents/:id/link-enrollment-tokens` (short-lived link enrollment secrets)
  - `POST /api/companies/:companyId/worker-instances/:workerInstanceId/link-enrollment-tokens` (instance-scoped link enrollment)
  - `POST /api/companies/:companyId/drone-provisioning-tokens` (drone-first bootstrap; high blast radius)
  - `PUT` / `DELETE` `/api/companies/:companyId/worker-instances/.../agents/...` (bind/unbind)
  - `POST /api/companies/:companyId/agents/:agentId/worker-pool/rotate` (automatic pool advance)
  - `PATCH /api/companies/:companyId/worker-instances/:workerInstanceId` (drone metadata / drain flag)
  - `POST /api/worker-tools/bridge` (agent tool bridge; allowlisted actions only)
  - `GET /api/worker-downloads/provision-manifest` and `GET /api/companies/:companyId/worker-runtime/manifest` (provisioning manifest leak / scrape surface)
  - `POST /api/invites/:token/accept`

When a client exceeds the limit, the server responds with `429 Too Many Requests` and `Retry-After`.

## Audit

Sensitive operations (key create, worker enrollment token mint, invite create/revoke, company delete) should be logged with actor and redacted payloads. Ensure activity logging is enabled and retained for compliance.

## Worker link authentication

Prefer **short-lived enrollment tokens** (`POST /api/agents/{id}/link-enrollment-tokens`) for onboarding operators to the worker WebSocket: single-use on successful connect, bounded TTL, plaintext shown once. Long-lived **agent API keys** remain for automation and CI; treat them as secrets (env files, secret stores), not copy-paste defaults in guided UI flows.

`GET /api/companies/{companyId}/drones/overview` returns only **metadata** (board agents / managed_worker identities, optional drone grouping, connection hints, hello fields, counts of unconsumed enrollment rows). It never returns enrollment plaintext or API keys.

## Managed worker pool — go-live checklist (instance mint / multi-agent hosts)

Before enabling **instance-scoped** link enrollment (`POST .../worker-instances/.../link-enrollment-tokens`), **drone provisioning** (`POST .../drone-provisioning-tokens`), and **multi–board-agent** drones in production:

- [ ] **Threat model** reviewed: [`doc/plans/threat-model-managed-worker-pool.md`](../../doc/plans/threat-model-managed-worker-pool.md) (designated owner sign-off); ADR 004 provision-token section for drone-first bootstrap.
- [ ] **AuthZ matrix** understood: [`doc/plans/authz-matrix-managed-worker-pool.md`](../../doc/plans/authz-matrix-managed-worker-pool.md); no expectation of a separate pool debug HTTP route (use company-scoped APIs + logs).
- [ ] **Multi-replica API:** `HIVE_WORKER_DELIVERY_BUS_URL` set to a **Redis-protocol** bus (TLS/ACL/private network per Placement section above) when more than one API replica runs.
- [ ] **Placement v1** (if used): `HIVE_PLACEMENT_V1_ENABLED` rollout plan, DB migrations applied, worker fleet supports `placementId` / `expectedWorkerInstanceId` per [`doc/plans/placement-policy-and-threat-model.md`](../../doc/plans/placement-policy-and-threat-model.md).
- [ ] **Automatic placement** (if used): `HIVE_AUTO_PLACEMENT_ENABLED` only with reviewed labels, drain policy, and agent `worker_placement_mode`; see [ADR 005](../../doc/adr/005-fleet-identity-assignment.md) and threat-model flag row.
- [ ] **Monitoring:** `placement_metric` logs and/or `429` on enrollment mint paths monitored; activity includes `worker_instance.link_enrollment_token_created` where applicable.
- [ ] **Provisioning manifest trust boundary:** only HTTPS URLs in `HIVE_WORKER_PROVISION_MANIFEST_*`; monitor 4xx/5xx on `GET /api/worker-downloads/provision-manifest` and company manifest routes.

## Provision manifest signing (optional, Ed25519)

When **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE`** or **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY`** is set, the control plane signs the **exact UTF-8 JSON body** of `GET /api/worker-downloads/provision-manifest` and `GET /api/companies/{companyId}/worker-runtime/manifest` using a **PKCS#8 PEM Ed25519 private key**. Responses include **`X-Hive-Manifest-Signature: v1-ed25519-<base64>`** (64-byte Ed25519 signature).

**hive-worker** sets **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** (32-byte public key as base64, or PEM) to **require** verification when fetching `HIVE_PROVISION_MANIFEST_URL`. If the public key is set and the header is missing or invalid, manifest load fails (fail closed). `HIVE_PROVISION_MANIFEST_JSON` on the worker bypasses HTTP signing (local operator trust only).

**Key rotation:** Ed25519 manifest signing uses a **single** pinned public key on the worker today. Plan a **short maintenance window**: deploy **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** on workers to the new public material, then switch **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_*`** on the server to the new private key (or the reverse order only if workers temporarily omit public-key enforcement — not recommended). There is **no dual-signature grace period** in `hive-worker`; mismatched key material fails closed until both sides agree.

**Worker identity automation:** Desired-state slots (`worker_identity_desired_slots`) are **board-only** CRUD; the server creates `managed_worker` rows when **`HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED`** is not `false`. Combine with **`HIVE_AUTO_PLACEMENT_ENABLED`** for automatic `worker_instance_agents` binding. Audit: activity actions `company.worker_identity_slot_*`. Periodic reconcile uses **`HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS`** (default 5 minutes; `0` disables the timer; provision-hello still reconciles).

**External provisioner:** Prefer populating `HIVE_PROVISION_CACHE_DIR` without granting the worker package managers; see [`infra/worker/PROVISIONER-SPLIT.md`](../../../../infra/worker/PROVISIONER-SPLIT.md).

## Release verification (drone / agent naming cutover)

After upgrading to a build that includes the breaking rename (single window: migrate DB → deploy API → deploy UI):

- **AuthZ:** Fuzz `companyId` on `GET /api/companies/{id}/drones/overview` — expect `403` when the principal cannot access that company (same as prior behavior for the old path).
- **Legacy routes:** `GET .../workers/overview` and `POST .../worker-enrollment-tokens` must **not** exist (404). Integrators should grep for removed paths; CI runs `pnpm check:legacy-drone-api` on production source.
- **Secrets:** Logs and SIEM rules must not match on enrollment token plaintext or `HIVE_AGENT_KEY`; alert on **rate limits** (`429`) for `POST .../link-enrollment-tokens` and key routes as before.
- **Database:** Operators applying migrations should see `managed_worker_link_enrollment_tokens` and optional `worker_instances.labels` / `drain_requested_at` / `capacity_hint` — confirm with `\d` / inspection after migrate.

**Placement v1 (optional):** With `HIVE_PLACEMENT_V1_ENABLED=true`, the server logs structured **`placement_metric`** events (`placement_created`, `placement_dispatch_failed`, `placement_dispatch_retry_scheduled`, `placement_active`, `placement_rejected`, `placement_mobility`) for SIEM correlation; they never contain enrollment secrets. `placement_mobility.kind` covers pool/drain/reconcile actions (for example `automatic_pool_rotate`, `drain_evacuate`, `drain_evacuate_skipped`, `automatic_assign_reconcile`) so dashboards can separate successful moves from skipped evacuation/reconcile outcomes. **Multi-replica API:** set **`HIVE_WORKER_DELIVERY_BUS_URL`** to a **Redis-protocol** endpoint (managed Redis, Dragonfly, Valkey, or compatible) for cross-replica WebSocket delivery; single-replica installs may omit it. **Hardening:** use **TLS** (`rediss://` where supported), **password/ACL**, private network only; do not expose the bus to the public internet. Optional **`HIVE_METRICS_ENABLED=true`** exposes **`GET /api/metrics`** — restrict by network (no app auth on that path by default). Policy: `doc/plans/placement-policy-and-threat-model.md`, `doc/plans/placement-in-flight-migration-policy.md`.

## Managed worker unified dispatch — rollback (ADR 003)

Rollback is a **release train**: deploy the **previous control-plane + worker** images that match each other’s dispatch assumptions. Do not expect an in-code toggle between “agent Map” and “instance Map” in one binary.

**Operator steps:**

1. Roll back **all** API replicas to the prior image; remove or stop using **`HIVE_WORKER_DELIVERY_BUS_URL`** if the old build did not use it.
2. **Worker fleet:** Use worker binaries compatible with the rolled-back API (see `infra/worker/RELEASES.md`).
3. **Database:** Keep migrations applied (forward-only). `worker_instance_link_enrollment_tokens` and extra `run_placements` columns remain harmless if unused.
4. **Verify:** Re-run smoke dispatch; watch for `placement_metric` / `429` on enrollment mint paths.

Threat model and AuthZ: `doc/plans/threat-model-managed-worker-pool.md`, `doc/plans/authz-matrix-managed-worker-pool.md`.
