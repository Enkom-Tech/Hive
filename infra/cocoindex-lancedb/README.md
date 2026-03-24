# CocoIndex v1 + LanceDB + llama.cpp (Qwen3-Embedding-8B)

Complete Docker + K3s setup for local Git repository indexing with Hive integration.

## Overview

This stack provides:
- **CocoIndex v1**: Main indexing service with tree-sitter chunking
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

### 3. Start Services (Docker Compose)

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
| `COCOINDEX_INDEX_ON_STARTUP` | `true` | Auto-index on startup |
| `COCOINDEX_WATCH_REPOS` | `true` | Watch for file changes |

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

## File Structure

```
.
├── docker-compose.yml          # Standalone Docker setup
├── Dockerfile                  # CocoIndex + LanceDB client
├── Dockerfile.lancedb          # LanceDB server
├── docker-entrypoint.sh        # Auto-index on startup
├── cocoindex_server.py         # Main Python server
├── lancedb_server.py           # LanceDB REST API
├── requirements.txt            # Python dependencies
├── k3d-k3s-setup.sh            # K3s cluster bootstrap
├── k8s/
│   └── hivecluster-indexer.yaml # Hive CRDs
├── control-plane-config.yaml   # Hive control-plane config
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

```
┌─────────────────────────────────────────────────────────────┐
│                         Hive Control Plane                    │
│                    (Node.js + PostgreSQL)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │ MCP / REST
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      CocoIndex API (8080)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ File Watcher │  │ Tree-sitter  │  │ REST API     │       │
│  │ (Incremental)│  │ Chunking     │  │ (FastAPI)    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  LanceDB     │ │ llama.cpp    │ │ Repos Volume │
│  (8890)      │ │ (8081)       │ │ (/data/repos)│
│  ┌──────────┐ │ │ ┌──────────┐ │ │              │
│  │ Vector   │ │ │ │ Qwen3-   │ │ │              │
│  │ Index    │ │ │ │ Embedding│ │ │              │
│  │ (IVF-PQ) │ │ │ │ 8B Q4_K_M│ │ │              │
│  └──────────┘ │ │ └──────────┘ │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

## License

MIT License - See Hive-Infra repository for details.
