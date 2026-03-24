# Docker Quickstart

Run Hive in Docker without installing Node or pnpm locally.

## Database options (Compose)

Pick one layout:

1. **Embedded Postgres** — [`docker-compose.quickstart.yml`](../docker-compose.quickstart.yml). Database files live under the bind mount with the rest of instance data. Requires `BETTER_AUTH_SECRET`.
2. **Postgres in Compose** — [`docker-compose.yml`](../docker-compose.yml). `db` service plus `server`; `DATABASE_URL` points at the `db` hostname. Requires `BETTER_AUTH_SECRET`.
3. **External Postgres** — [`docker-compose.external-db.yml`](../docker-compose.external-db.yml). You run PostgreSQL on the host, another VM, or a managed service; pass `DATABASE_URL` reachable from inside the container. Requires `DATABASE_URL` and `BETTER_AUTH_SECRET`. See [Compose with external PostgreSQL](#compose-with-external-postgresql).

## One-liner (build + run)

```sh
docker build -t hive-local . && \
docker run --name hive \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e HIVE_HOME=/hive \
  -v "$(pwd)/data/docker-hive:/hive" \
  hive-local
```

Open: `http://localhost:3100`

Data persistence:

- Embedded PostgreSQL data
- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-hive` in the example above).

## Compose Quickstart

```sh
export BETTER_AUTH_SECRET='...'   # long random secret (authenticated mode)
docker compose -f docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-hive`

Optional overrides:

```sh
HIVE_PORT=3200 HIVE_DATA_DIR=./data/pc BETTER_AUTH_SECRET='...' \
  docker compose -f docker-compose.quickstart.yml up --build
```

If you change host port or use a non-local domain, set `HIVE_PUBLIC_URL` to the external URL you will use in browser/auth flows.

## Compose with external PostgreSQL

Minimal env: `DATABASE_URL` (reachable from **inside** the container), `BETTER_AUTH_SECRET`, and usually `HIVE_PUBLIC_URL` (defaults to `http://localhost:3100`).

```sh
export DATABASE_URL='postgres://hive:hive@host.docker.internal:5432/hive'
export BETTER_AUTH_SECRET='...'
docker compose -f docker-compose.external-db.yml up --build
```

Using a file (see [`.env.docker.example`](../.env.docker.example)):

```sh
cp .env.docker.example .env
# edit .env — set DATABASE_URL and BETTER_AUTH_SECRET
docker compose --env-file .env -f docker-compose.external-db.yml up --build
```

[`docker-compose.external-db.yml`](../docker-compose.external-db.yml) adds `extra_hosts: host.docker.internal:host-gateway` so `host.docker.internal` resolves on Linux as well as Docker Desktop.

**PostgreSQL on the Docker host** must accept connections from the container network. Typically:

- `listen_addresses` in `postgresql.conf` includes an address the container can reach (often `*` or a non-loopback interface), not only `127.0.0.1`, when using `host.docker.internal`.
- `pg_hba.conf` allows the Docker bridge subnet (or your chosen auth rule) for your DB user.

For a database on another host or managed service, put that hostname or IP in `DATABASE_URL` instead of `host.docker.internal`.

**Bind mount:** `HIVE_DATA_DIR` (default `./data/docker-hive`) still stores instance files (config, secrets key, storage, logs). It does **not** replace the external database’s data directory.

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let Hive derive auth/callback defaults:

```yaml
services:
  hive:
    environment:
      HIVE_DEPLOYMENT_MODE: authenticated
      HIVE_DEPLOYMENT_EXPOSURE: private
      HIVE_PUBLIC_URL: https://desk.koker.net
```

`HIVE_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

Granular overrides remain available if needed (`HIVE_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `HIVE_ALLOWED_HOSTNAMES`).

Set `HIVE_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

If you want local adapter runs inside the container, pass API keys when starting the container:

```sh
docker run --name hive \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e HIVE_HOME=/hive \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -v "$(pwd)/data/docker-hive:/hive" \
  hive-local
```

Notes:

- Without API keys, the app still runs normally.
- Adapter environment checks in Hive will surface missing auth/CLI prerequisites.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `pnpm hive onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 HIVE_VERSION=latest ./scripts/docker-onboard-smoke.sh
HIVE_DEPLOYMENT_MODE=authenticated HIVE_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local Hive on `3100`.
- Smoke script also defaults `HIVE_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `hive auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- The image definition is in `Dockerfile.onboard-smoke`.
