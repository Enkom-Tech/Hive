# Hive DocIndex (non-code) + LanceDB + llama.cpp

Parallel service to [CocoIndex](../cocoindex-lancedb/): **mount → parse (Docling / Unstructured) → chunk → embed → LanceDB → REST/MCP**.

## Stack

- **Docling**: PDF, DOCX, PPTX, XLSX (layout-aware markdown export).
- **Unstructured**: Fallback and HTML, email, plain text, etc.
- **LanceDB**: Table `document_embeddings` (separate from Coco’s `code_embeddings`; same URI is fine, different table).
- **Embeddings**: Same llama.cpp server contract as Coco (`POST {base}/embedding`, `{"input": [...]}`). Default dim **4096** (Qwen3-Embedding-8B). If you use another model, set `DOCINDEX_EMBEDDING_DIM` and **do not** mix vectors in the same table.

## Quick start (Docker Compose)

1. Put **Qwen3-Embedding-8B** GGUF under `./models/` (same as CocoIndex README).
2. Copy `.env.example` to `.env` and set `DOCINDEX_API_TOKEN`, `DOCINDEX_QUEUE_PASSWORD`, and `DOCINDEX_JOB_SIGNING_KEY`. See [docs/secrets.md](../../docs/secrets.md) for K8s provisioning patterns.
3. Create `./mydocs/` and add PDF/MD/HTML files.
4. Run:

```bash
docker compose up -d
```

5. Check health (no auth):

```bash
curl http://localhost:8082/health
```

6. Search (requires token):

```bash
curl -H "Authorization: Bearer $DOCINDEX_API_TOKEN" \
  "http://localhost:8082/search?q=your+query&limit=5"
```

## API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Liveness |
| `POST /index` | Bearer | Index `mydocs` tree or optional `paths` |
| `GET/POST /search` | Bearer | Semantic search + optional `source_id`, `acl_scope`, `mime` |
| `GET /stats` | Bearer | Chunk count |
| `GET /mcp`, `POST /mcp/message` | Bearer | MCP tools: `search_documents`, `index_documents`, `get_index_stats` |

### MCP and hive-worker

DocIndex exposes MCP on the **same** bearer token as the REST API. For **hive-worker** (`HIVE_MCP_DOCS_*` pointing at this service), set **`DOCINDEX_MCP_WORKER_SAFE=1`**: admin tools listed under the `docindex` key in [`../cocoindex-lancedb/mcp-gateway-go/blocklist.json`](../cocoindex-lancedb/mcp-gateway-go/blocklist.json) are omitted from `tools/list` and rejected on `tools/call` (today: `index_documents`, `force_reindex`). Prefer the **CocoIndex HTTP MCP gateway** in docindex mode when you want identical blocking and logging to the code path; use native DocIndex MCP only when you accept this env-gated split.

## Configuration (environment)

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCINDEX_DOCS_PATH` | `/data/docs` | Mounted documents root |
| `DOCINDEX_LANCEDB_URI` | `/data/lancedb` | LanceDB directory |
| `DOCINDEX_EMBEDDING_URL` | `http://llama-embeddings:8080` | llama.cpp **base** URL (path `/embedding` appended) |
| `DOCINDEX_EMBEDDING_DIM` | `4096` | Must match model output |
| `DOCINDEX_API_PORT` | `8082` | HTTP port |
| `DOCINDEX_DEFAULT_SOURCE_ID` | `default` | Logical source tag (filter-safe id) |
| `DOCINDEX_DEFAULT_ACL_SCOPE` | `public` | MVP ACL tag for query filters |
| `DOCINDEX_CHUNK_SIZE` | `2000` | Chunk character budget |
| `DOCINDEX_CHUNK_OVERLAP` | `200` | Overlap between windows |
| `DOCINDEX_EMBEDDING_BATCH_SIZE` | `32` | Texts per embedding HTTP request (API + worker) |
| `DOCINDEX_EMBEDDING_MAX_CONCURRENT_BATCHES` | `1` | Concurrent embedding requests from the API process |
| `DOCINDEX_RATE_LIMIT_INDEX` | `10/minute` | slowapi limit on `POST /index` |
| `DOCINDEX_RATE_LIMIT_SEARCH` | `60/minute` | slowapi limit on search |
| `DOCINDEX_AUTH_SUCCESS_LOG_SAMPLE_RATE` | `0` | Successful auth audit sampling: `0` = log failures only; `1` = log every success; `(0,1)` = random sample (reduces log I/O) |
| `DOCINDEX_MCP_WORKER_SAFE` | unset | When `1`/`true`, apply worker-tier MCP blocklist (see MCP section above). |
| `DOCINDEX_MCP_BLOCKLIST_FILE` | repo `cocoindex-lancedb/mcp-gateway-go/blocklist.json` | Override path; JSON must include a `docindex` array. |

## Layout

```
.
├── docindex_server.py   # FastAPI app, LanceDB, indexer, MCP
├── docindex_mcp_policy.py # Worker-safe MCP tool blocklist (shared JSON with CocoIndex)
├── document_parsers.py  # Docling + Unstructured routing
├── document_chunker.py  # Heading-aware + sliding windows
├── auth.py
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── tests/unit/
```

## Kubernetes

See [k8s/docindex.yaml](k8s/docindex.yaml) for a minimal Deployment + Service example (adjust images, secrets, and volumes). The parser worker Deployment can run **multiple replicas** (same Redis list, `BRPOP`); prefer scaling replicas over increasing in-process thread pools unless Docling/Unstructured are verified thread-safe. Set `DOCINDEX_JOB_SIGNING_KEY` on API and worker in production.

### Hive operator (`HiveDocIndexer`)

The Hive operator can reconcile a **`HiveDocIndexer`** CR ([CRD](../operator/config/crd/bases/hive.io_hivedocindexers.yaml)): slim API Deployment, parser worker Deployment, LanceDB + docs PVCs, optional HTTP MCP gateway. You must provision a **Redis** Secret in the tenant namespace (`redisUrlSecretRef`, key **`url`**) before the reconciler can run queue mode.

For the MCP gateway image, build [`../cocoindex-lancedb/Dockerfile.gateway`](../cocoindex-lancedb/Dockerfile.gateway). The operator sets **`GATEWAY_DOCINDEX_MODE=1`** on the gateway pod so worker-tier tools cannot call `index_documents` via MCP. Workers receive **`HIVE_MCP_DOCS_URL`** / **`HIVE_MCP_DOCS_TOKEN`** when the gateway is configured; agents use **`documents.search`** / **`documents.indexStats`** through **`hive-worker mcp`** (stdio), not a second MCP client.

## Performance notes

- Inline indexing (`DOCINDEX_USE_WORKER_QUEUE=false`): vector index refresh runs **once** after a bulk `POST /index`, not after every file’s embedding batches.
- Queue mode: each worker result still triggers index maintenance on upsert (one job at a time per replica).
- Logs: `embed_batch_complete`, `lance_merge_insert_ms`, `vector_index_finalize_ms`, `search_query_embed_ms` (debug); `index_documents_complete` (info).
- **Large libraries:** `get_existing_hashes` / `get_existing_file_byte_hashes` scan rows per `source_id`. If that becomes hot, evaluate LanceDB scalar indexes on `source_id` + `file_path` or an external metadata store.

## Docker image size

`docling` installs **PyTorch** and related wheels; the production image is typically **multi‑GB**. Parsing runs on CPU by default inside the container unless you configure GPU; embeddings still use the separate **llama.cpp** service in `docker-compose.yml`.

## Limitations (v1)

- Scanned PDFs / OCR quality depends on Docling configuration.
- Optional URL ingest: set **`DOCINDEX_SCRAPE_ALLOWED_HOSTS`** (comma-separated hostnames), then pass **`fetch_urls`** on `POST /index`. **`DOCINDEX_SCRAPE_MAX_BYTES`**, **`DOCINDEX_SCRAPE_TIMEOUT_SEC`**, and **`DOCINDEX_SCRAPE_ALLOW_PRIVATE_IPS`** tune behavior (private IPs blocked by default). See [`docindex_url_fetch.py`](docindex_url_fetch.py).
- `source_id` / `acl_scope` filters use strict safe-string patterns; complex ACL belongs in a later phase.

## License

MIT — same as Hive-Infra repository.
