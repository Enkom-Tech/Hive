# Bifrost and Hive inference metering

The Go router (`infra/model-gateway-go`) can POST aggregate usage to the control plane (`POST /api/internal/hive/inference-metering`, see [`main.go`](../model-gateway-go/main.go)). **Bifrost** can use the **`hive_metering`** plugin in [`../bifrost-hive-metering`](../bifrost-hive-metering) plus **`GET /api/internal/hive/gateway-virtual-key-lookup`** (operator secret) to resolve **`sha256(sk-bf-*)`** → **`companyId`** before posting the same JSON shape.

## Goals

- **Financial / product accuracy:** Company-scoped token or cost rows in Hive Postgres match gateway reality.
- **Streaming:** Many completions use `stream: true`; usage may appear only in the **final SSE chunk** or not at all until the stream completes. Any metering design must state how streaming is handled.

## Option 1 — Bifrost plugin (recommended when Hive DB must stay authoritative)

Shipped module: [`../bifrost-hive-metering`](../bifrost-hive-metering) — **`LLMPlugin.PostLLMHook`** that:

1. Hashes the request **`sk-bf-*`** (SHA-256 hex) and calls **`GET /api/internal/hive/gateway-virtual-key-lookup?keyHash=...`** with the operator bearer.
2. Reads **`usage`** from **`ChatResponse`**, **`TextCompletionResponse`**, or **`ResponsesResponse`** when present (streaming: hooks that carry usage are counted; the Hive **`idempotencyKey`** on `POST /api/internal/hive/inference-metering` dedupes identical Bifrost plugin posts and model-gateway posts include a hash of the upstream body).

POST body matches `postMeteringAsync` in `model-gateway-go` (`source: gateway_aggregate`, **`provider: bifrost`** by default). Configure **`operator_bearer`** = **`HIVE_INTERNAL_OPERATOR_SECRET`**.

**Effort:** Build `-buildmode=plugin` on Linux aligned with Bifrost’s Go version; register the `.so` in Bifrost config.

## Option 2 — Export and ETL

Use Bifrost’s **logs store** (SQLite/Postgres) or **Prometheus metrics** as the source. A batch job (hourly/daily) aggregates tokens per virtual key and pushes to Hive via a **new** bulk internal API or manual import.

**Pros:** No hot-path plugin. **Cons:** Latency; schema mapping; still need VK → `company_id` mapping.

## Option 3 — Interim gap (explicit acceptance)

Run Bifrost with governance budgets only; **Hive cost rows for gateway traffic are incomplete** until Option 1 or 2 exists. Document in operator runbooks and product release notes.

## Decision record

Record the chosen option in the environment-specific runbook ([`BIFROST-RUNBOOK.md`](BIFROST-RUNBOOK.md)) and revisit when streaming metering accuracy becomes a blocker.
