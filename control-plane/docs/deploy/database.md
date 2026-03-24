---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Hive uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.hive/instances/default/db/` for storage
2. Ensures the database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.hive/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

Use the `db` service from [`docker-compose.yml`](../../docker-compose.yml) (PostgreSQL 17, user/password/db `hive`, published on host port **5432**).

**Control-plane on the host, database in Docker** (typical dev):

```sh
cd control-plane
docker compose up -d db
```

Start only `db`. A bare `docker compose up -d` also starts the **Hive server container** on port 3100; skip that when you run `pnpm dev` locally.

Set the connection string where Hive reads env (for the default instance, often `~/.hive/instances/default/.env` on Unix or `%USERPROFILE%\.hive\instances\default\.env` on Windows):

```sh
DATABASE_URL=postgres://hive:hive@localhost:5432/hive
```

Then from `control-plane`:

```sh
pnpm dev
```

If port 5432 is already in use, change the **host** side of the port mapping in Compose (e.g. `5433:5432`) and use `localhost:5433` in `DATABASE_URL`.

**Schema / migrations:** from repo root with `DATABASE_URL` set, or use the server’s migration flow on startup. Example using Drizzle CLI:

```sh
DATABASE_URL=postgres://hive:hive@localhost:5432/hive \
  npx drizzle-kit push
```

**Both stack in Docker:** `docker compose up -d` starts `db` and the built **server** image; use that when you are not running Node locally (see [Docker](docker.md)).

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If using connection pooling, disable prepared statements:

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
