## 3. docker-entrypoint.sh (auto-index on startup)
#!/bin/bash
set -e

# -----------------------------------------------------------------------------
# CocoIndex v1 Entrypoint Script
# -----------------------------------------------------------------------------

echo "==============================================="
echo "  CocoIndex v1 + LanceDB + llama.cpp"
echo "==============================================="

# Wait for dependencies
echo "[1/4] Waiting for dependencies..."
wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=30
    local attempt=1
    
    while ! curl -sf "$url" > /dev/null 2>&1; do
        if [ $attempt -ge $max_attempts ]; then
            echo "ERROR: $name did not become ready in time"
            exit 1
        fi
        echo "  Waiting for $name... ($attempt/$max_attempts)"
        sleep 2
        attempt=$((attempt + 1))
    done
    echo "  $name is ready!"
}

# Wait for llama.cpp embedding server
wait_for_service "${COCOINDEX_EMBEDDING_URL}/health" "llama.cpp embeddings"

# Wait for LanceDB (check if directory is writable)
echo "[2/4] Checking LanceDB..."
mkdir -p "${COCOINDEX_LANCEDB_URI}"
if [ ! -w "${COCOINDEX_LANCEDB_URI}" ]; then
    echo "ERROR: LanceDB directory is not writable: ${COCOINDEX_LANCEDB_URI}"
    exit 1
fi
echo "  LanceDB directory is ready!"

# Check repositories
echo "[3/4] Checking repositories..."
if [ ! -d "${COCOINDEX_REPOS_PATH}" ]; then
    echo "WARNING: Repos path does not exist: ${COCOINDEX_REPOS_PATH}"
    echo "  Creating empty directory..."
    mkdir -p "${COCOINDEX_REPOS_PATH}"
else
    repo_count=$(find "${COCOINDEX_REPOS_PATH}" -maxdepth 1 -type d | wc -l)
    repo_count=$((repo_count - 1))  # Exclude the parent directory
    echo "  Found $repo_count repositories"
    
    # List found repos
    for repo in "${COCOINDEX_REPOS_PATH}"/*/; do
        if [ -d "$repo" ]; then
            echo "    - $(basename "$repo")"
        fi
    done
fi

# -----------------------------------------------------------------------------
# Run command
# -----------------------------------------------------------------------------
echo "[4/4] Starting CocoIndex server..."
echo "==============================================="

case "${1:-server}" in
    server)
        echo "Starting server on ${COCOINDEX_API_HOST}:${COCOINDEX_API_PORT}"
        exec python /app/cocoindex_server.py
        ;;
    
    index)
        echo "Running one-time indexing..."
        # Import and run indexer directly
        exec python -c "
import asyncio
import sys
sys.path.insert(0, '/app')
from cocoindex_server import CocoIndexer, settings

async def main():
    indexer = CocoIndexer()
    await indexer.initialize()
    result = await indexer.index_repositories(force=True)
    print(f'Indexing complete: {result}')
    await indexer.close()

asyncio.run(main())
"
        ;;
    
    shell)
        echo "Starting shell..."
        exec /bin/bash
        ;;
    
    *)
        echo "Running custom command: $@"
        exec "$@"
        ;;
esac
