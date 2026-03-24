---
title: Docker
summary: Docker Compose (embedded, bundled DB, or external PostgreSQL)
---

Run Hive in Docker without installing Node or pnpm locally.

## Database options

1. **Embedded Postgres** — [`docker-compose.quickstart.yml`](../../docker-compose.quickstart.yml). DB files under the bind mount. Needs `BETTER_AUTH_SECRET`.
2. **Postgres in Compose** — [`docker-compose.yml`](../../docker-compose.yml). `db` + `server` services. Needs `BETTER_AUTH_SECRET`.
3. **External Postgres** — [`docker-compose.external-db.yml`](../../docker-compose.external-db.yml). Set `DATABASE_URL` to a server reachable from the container. Needs `DATABASE_URL` and `BETTER_AUTH_SECRET`. See [External PostgreSQL](#external-postgresql).

To run **only** the Compose `db` service while developing with **`pnpm dev`** on the host, use `docker compose up -d db` and set `DATABASE_URL` to `localhost` — see [Database — local PostgreSQL (Docker)](database.md#2-local-postgresql-docker).

## Compose Quickstart (embedded Postgres)

```sh
export BETTER_AUTH_SECRET='...'
docker compose -f docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-hive`

Override with environment variables:

```sh
HIVE_PORT=3200 HIVE_DATA_DIR=./data/pc BETTER_AUTH_SECRET='...' \
  docker compose -f docker-compose.quickstart.yml up --build
```

## External PostgreSQL

Use your own PostgreSQL (host install, another machine, or managed DB). The connection string must work from **inside** the container.

```sh
export DATABASE_URL='postgres://hive:hive@host.docker.internal:5432/hive'
export BETTER_AUTH_SECRET='...'
docker compose -f docker-compose.external-db.yml up --build
```

Copy [`.env.docker.example`](../../.env.docker.example) to `.env`, fill in values, then:

```sh
docker compose --env-file .env -f docker-compose.external-db.yml up --build
```

The compose file sets `host.docker.internal` → `host-gateway` for Linux. On the **host**, ensure Postgres listens on an interface Docker can reach and `pg_hba.conf` allows the Docker subnet.

If you change `HIVE_PORT`, set `HIVE_PUBLIC_URL` to match the URL you open in the browser.

The bind mount (`HIVE_DATA_DIR`) still holds Hive instance data (secrets, storage, logs); it is not the external database’s data directory.

## Manual Docker Build

```sh
docker build -t hive-local .
docker run --name hive \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e HIVE_HOME=/hive \
  -v "$(pwd)/data/docker-hive:/hive" \
  hive-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-hive`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Claude and Codex Adapters in Docker

The Docker image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name hive \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e HIVE_HOME=/hive \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-hive:/hive" \
  hive-local
```

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
