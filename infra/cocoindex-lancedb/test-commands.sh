## 7. Test curls: index/search a sample repo
#!/bin/bash

# =============================================================================
# CocoIndex v1 + LanceDB Test Commands
# =============================================================================

COCOINDEX_URL="${COCOINDEX_URL:-http://localhost:8080}"
LANCEDB_URL="${LANCEDB_URL:-http://localhost:8890}"
LLAMA_URL="${LLAMA_URL:-http://localhost:8081}"

echo "==============================================="
echo "  CocoIndex Test Commands"
echo "==============================================="
echo "CocoIndex: $COCOINDEX_URL"
echo "LanceDB:   $LANCEDB_URL"
echo "llama.cpp: $LLAMA_URL"
echo "==============================================="

# =============================================================================
# 1. Health Checks
# =============================================================================

echo ""
echo "1. Health Checks"
echo "==============================================="

echo "Checking llama.cpp embedding server..."
curl -s "$LLAMA_URL/health" | jq .

echo ""
echo "Checking LanceDB..."
curl -s "$LANCEDB_URL/health" | jq .

echo ""
echo "Checking CocoIndex..."
curl -s "$COCOINDEX_URL/health" | jq .

# =============================================================================
# 2. Embedding Test (direct llama.cpp)
# =============================================================================

echo ""
echo "2. Test Embedding Generation"
echo "==============================================="

curl -s -X POST "$LLAMA_URL/embedding" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "def hello_world(): print('\"'"'"'Hello, World!'"'"'"')"
  }' | jq '.data[0].embedding[:5] | "First 5 dimensions: " + tostring'

# =============================================================================
# 3. Indexing Operations
# =============================================================================

echo ""
echo "3. Trigger Repository Indexing"
echo "==============================================="

echo "Indexing all repositories (incremental)..."
curl -s -X POST "$COCOINDEX_URL/index" \
  -H "Content-Type: application/json" \
  -d '{
    "repo_path": null,
    "force_reindex": false
  }' | jq .

echo ""
echo "Force reindex all repositories..."
curl -s -X POST "$COCOINDEX_URL/index" \
  -H "Content-Type: application/json" \
  -d '{
    "repo_path": null,
    "force_reindex": true
  }' | jq .

# =============================================================================
# 4. Search Operations
# =============================================================================

echo ""
echo "4. Code Search (GET method)"
echo "==============================================="

echo "Searching for 'authentication middleware'..."
curl -s "$COCOINDEX_URL/search?q=authentication+middleware&limit=5" | jq '.[] | {file: .file_path, score: .score, snippet: .content[:100]}'

echo ""
echo "Searching for 'database connection pool'..."
curl -s "$COCOINDEX_URL/search?q=database+connection+pool&limit=5" | jq '.[] | {file: .file_path, score: .score, snippet: .content[:100]}'

echo ""
echo "Searching Python code for 'async def'..."
curl -s "$COCOINDEX_URL/search?q=async+def&language=python&limit=5" | jq '.[] | {file: .file_path, score: .score, snippet: .content[:100]}'

# =============================================================================
# 5. Search Operations (POST method)
# =============================================================================

echo ""
echo "5. Code Search (POST method with filters)"
echo "==============================================="

echo "Searching with POST request..."
curl -s -X POST "$COCOINDEX_URL/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "error handling retry logic",
    "language": "python",
    "limit": 10
  }' | jq '.[] | {file: .file_path, language: .language, score: .score, lines: "\(.chunk_start)-\(.chunk_end)"}'

# =============================================================================
# 6. Statistics
# =============================================================================

echo ""
echo "6. Indexing Statistics"
echo "==============================================="

curl -s "$COCOINDEX_URL/stats" | jq .

# =============================================================================
# 7. LanceDB Direct Queries
# =============================================================================

echo ""
echo "7. LanceDB Direct Table Info"
echo "==============================================="

curl -s "$LANCEDB_URL/api/v1/table/code_embeddings" | jq .

# =============================================================================
# 8. Sample Repository Setup
# =============================================================================

echo ""
echo "8. Sample Repository Setup"
echo "==============================================="
echo ""
echo "To test with a sample repository, run:"
echo ""
echo "  # Clone a sample repo"
echo "  mkdir -p ./myrepo"
echo "  cd ./myrepo"
echo "  git clone --depth 1 https://github.com/fastapi/fastapi.git"
echo "  cd .."
echo ""
echo "  # Restart cocoindex to index the new repo"
echo "  docker-compose restart cocoindex"
echo ""
echo "  # Or trigger reindex via API"
echo "  curl -X POST http://localhost:8080/index -H 'Content-Type: application/json' -d '{\"force_reindex\": true}'"
echo ""

# =============================================================================
# 9. Performance Testing
# =============================================================================

echo ""
echo "9. Performance Testing"
echo "==============================================="

echo "Running 10 sequential searches..."
for i in {1..10}; do
  start=$(date +%s%N)
  curl -s "$COCOINDEX_URL/search?q=function+definition&limit=5" > /dev/null
  end=$(date +%s%N)
  duration=$(( (end - start) / 1000000 ))
  echo "Search $i: ${duration}ms"
done

# =============================================================================
# 10. Error Handling Tests
# =============================================================================

echo ""
echo "10. Error Handling Tests"
echo "==============================================="

echo "Testing invalid query (empty)..."
curl -s -X POST "$COCOINDEX_URL/search" \
  -H "Content-Type: application/json" \
  -d '{"query": ""}' | jq .

echo ""
echo "Testing non-existent endpoint..."
curl -s "$COCOINDEX_URL/nonexistent" | jq .

# =============================================================================
# End of Tests
# =============================================================================

echo ""
echo "==============================================="
echo "  Test Complete!"
echo "==============================================="
