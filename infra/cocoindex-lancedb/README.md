# CocoIndex v1 + LanceDB + llama.cpp (Qwen3-Embedding-8B)

Complete Docker + K3s setup for local Git repository indexing with Hive integration.

## Overview

This stack provides:
- **CocoIndex v1**: Main indexing service; optional **`COCOINDEX_AST_CHUNK_PY=1`** uses Python `ast` top-level splits for `.py` (line-based fallback otherwise). Full tree-sitter grammars remain optional future work.
- **LanceDB**: Embedded vector database for code embeddings
- **llama.cpp**: Qwen3-Embedding-8B (4096-dim, 32K context) for embeddings
- **Hive Integration**: K3s operator + CRDs for auto-indexing

## Quick Start

### Prerequisites

- Docker + Docker Compose
- k3d (for K8s deployment)
- kubectl + Helm
- WSL2 (Windows) or Linux

### 1. Download Model

```bash
mkdir -p models
cd models
wget https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/qwen3-embedding-8b-Q4_K_M.gguf
cd ..
```

### 2. Clone Sample Repo

```bash
mkdir -p myrepo
cd myrepo
git clone --depth 1 https://github.com/fastapi/fastapi.git
cd ..
```

### 3. Configure Secrets

Copy `.env.example` to `.env` and set required values before starting. For K8s provisioning (Sealed Secrets, External Secrets Operator, Vault Agent), see [docs/secrets.md](../../docs/secrets.md).

### 4. Start Services (Docker Compose)

```bash
docker-compose up -d

# Check status
docker-compose ps
```

### 4. Test

```bash
./test-commands.sh
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/index` | POST | Trigger indexing |
| `/search` | GET/POST | Search code |
| `/stats` | GET | Indexing statistics |

### Example Queries

```bash
# Health check
curl http://localhost:8080/health

# Search code
curl "http://localhost:8080/search?q=authentication+middleware&limit=5"

# Index repositories
curl -X POST http://localhost:8080/index \
  -H "Content-Type: application/json" \
  -d '{"force_reindex": true}'
```

## K3s Deployment

```bash
# Create cluster with all components
./k3d-k3s-setup.sh all

# Or step by step
./k3d-k3s-setup.sh cluster-only
./k3d-k3s-setup.sh cocoindex-only

# Port forward
kubectl port-forward -n cocoindex svc/cocoindex 8080:8080

# Delete cluster
./k3d-k3s-setup.sh delete
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COCOINDEX_REPOS_PATH` | `/data/repos` | Repository mount path |
| `COCOINDEX_LANCEDB_URI` | `/data/lancedb` | LanceDB storage path |
| `COCOINDEX_EMBEDDING_URL` | `http://llama-embeddings:8080` | Embedding service URL |
| `COCOINDEX_EMBEDDING_DIM` | `4096` | Embedding dimensions |
| `COCOINDEX_EMBEDDING_OPENAI_COMPATIBLE` | (unset) | When `true`/`1`, call `POST {embedding_url}/v1/embeddings` (OpenAI shape) instead of llama.cpp paths |
| `COCOINDEX_EMBEDDING_MODEL_ID` | (unset) | Model id sent in the OpenAI-compatible embedding body (required if OpenAI mode is on) |
| `COCOINDEX_INDEX_ON_STARTUP` | `true` | Auto-index on startup |
| `COCOINDEX_WATCH_REPOS` | `true` | Watch for file changes |
| `COCOINDEX_EMBEDDING_BATCH_SIZE` | `32` | Texts per embedding HTTP request |
| `COCOINDEX_EMBEDDING_MAX_CONCURRENT_BATCHES` | `1` | Concurrent in-flight embedding requests (raise only if the embed server can handle it) |
| `COCOINDEX_MAX_CONCURRENT_FILE_TASKS` | `8` | Concurrent worker threads for read+chunk during repo indexing |
| `COCOINDEX_RATE_LIMIT_INDEX` | `10/minute` | slowapi limit on `POST /index` |
| `COCOINDEX_RATE_LIMIT_SEARCH` | `60/minute` | slowapi limit on search routes |

Point `COCOINDEX_EMBEDDING_URL` at the same unified model router as chat when you centralize routes; keep direct llama.cpp URLs when batch latency matters.

### Performance notes

- Bulk indexing defers LanceDB vector-index maintenance until the end of each `_embed_and_upsert` (and DocIndex inline bulk defers until the end of the full index run), instead of after every embedding batch.
- Logs (JSON): `embed_batch_complete`, `lance_merge_insert_ms`, `vector_index_finalize_ms`, `search_query_embed_ms` (debug); `index_repositories_complete`, `vector_index_finalize_ms` (info).
- **Large corpora:** `get_existing_hashes` loads all `(file_path, file_hash)` rows for a repo. If that scan dominates, evaluate LanceDB scalar/BTREE indexes on `repo_name` + `file_path`, a compact sidecar store, or periodic full reindex — trade-offs are ops complexity vs. query latency.

### Hive CRD

```yaml
apiVersion: hive.io/v1alpha1
kind: HiveCluster
metadata:
  name: cocoindex-cluster
spec:
  storage:
    type: lancedb
    endpoint: "http://lancedb.cocoindex.svc.cluster.local:8000"
  embedding:
    type: llama.cpp
    endpoint: "http://llama-embeddings.cocoindex.svc.cluster.local:8080"
    model: "qwen3-embedding-8b-Q4_K_M.gguf"
    dimensions: 4096
  indexing:
    repoPath: "/data/repos"
    watchRepos: true
    autoIndex: true
```

## Hive integration (MCP and cost events)

### MCP gateway (Python vs Go)

- **Python:** `mcp_gateway.py` — default in operator manifests today. Set **`GATEWAY_DOCINDEX_MODE=1`** when pointing at a DocIndex API (port 8082); the HiveDocIndexer operator sets this automatically.
- **Go:** `mcp-gateway-go/` — same env vars (`GATEWAY_WORKER_TOKEN`, `GATEWAY_ADMIN_TOKEN`, `GATEWAY_INDEXER_URL`), plus **`GATEWAY_DOCINDEX_MODE=1`** when the indexer URL targets DocIndex (port 8082), matching Python behavior.
- **Shared blocklist:** `mcp-gateway-go/blocklist.json` lists tools blocked for the worker tier in **cocoindex** vs **docindex** mode; Python loads the same file (override path with **`GATEWAY_WORKER_BLOCKLIST_FILE`**).
- **Agents:** use **`hive-worker mcp`** (stdio) only. The worker pod receives **`HIVE_MCP_CODE_URL` / `HIVE_MCP_CODE_TOKEN`** (and legacy **`HIVE_MCP_URL` / `HIVE_MCP_TOKEN`**) and exposes tools **`code.search`** / **`code.indexStats`** that proxy to this gateway—agents do not hold indexer tokens.

### RAG indexing and `cost_events`

Indexing-related usage can be recorded in `cost_events` with `source: rag_index` and `agent_id` null (company-level rows). Emit batches after index runs using token or wall-clock estimates from your embedding backend; align embedding model ids with `inference_models.kind = embed` in the control plane when you use the shared catalog.

## File Structure

```
.
├── docker-compose.yml          # Standalone Docker setup
├── Dockerfile                  # CocoIndex + LanceDB client
├── Dockerfile.lancedb          # LanceDB server
├── docker-entrypoint.sh        # Auto-index on startup
├── cocoindex_server.py         # Main Python server
├── mcp_gateway.py              # MCP edge proxy (Python)
├── mcp-gateway-go/             # MCP edge proxy (Go, optional)
├── lancedb_server.py           # LanceDB REST API
├── requirements.txt            # Python dependencies
├── k3d-k3s-setup.sh            # K3s cluster bootstrap
├── k8s/
│   └── hivecluster-indexer.yaml # Hive CRDs
├── control-plane-config.yaml   # Illustrative YAML only — NOT loaded by Hive TS (see file header)
├── test-commands.sh            # Test curls
├── WSL2-SETUP.md               # WSL2 setup guide
└── README.md                   # This file
```

## Ports

| Service | Port | Description |
|---------|------|-------------|
| CocoIndex | 8080 | Main API |
| LanceDB | 8890 | Vector database |
| llama.cpp | 8081 | Embedding server |

## WSL2 Notes

See [WSL2-SETUP.md](WSL2-SETUP.md) for detailed WSL2 installation instructions including:
- Docker Desktop vs Docker CE
- k3d, kubectl, Helm installation
- Go 1.26+ setup
- NVIDIA GPU support
- Troubleshooting

## Architecture

**Hive + managed worker (implemented):** agents use **`hive-worker mcp`** (stdio), which proxies search tools to the **MCP gateway** in cluster; the control plane does **not** call CocoIndex directly. The diagram below is the **standalone stack** (compose / local): control plane is shown for context only—not a live integration wire in this repo.

```
┌─────────────────────────────────────────────────────────────┐
│                     Hive Control Plane                      │
│                    (Node.js + PostgreSQL)                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ MCP / REST (standalone / illustrative)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      CocoIndex API (8080)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ File Watcher │  │ AST / line   │  │ REST API     │       │
│  │ (Incremental)│  │ chunking     │  │ (FastAPI)    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼             ▼             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  LanceDB     │ │ llama.cpp    │ │ Repos Volume │
│  (8890)      │ │ (8081)       │ │ (/data/repos)│
│ ┌──────────┐ │ │ ┌──────────┐ │ │              │
│ │ Vector   │ │ │ │ Qwen3-   │ │ │              │
│ │ Index    │ │ │ │ Embedding│ │ │              │
│ │ (IVF-PQ) │ │ │ │ 8B Q4_K_M│ │ │              │
│ └──────────┘ │ │ └──────────┘ │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

## License

MIT License - See Hive-Infra repository for details.
