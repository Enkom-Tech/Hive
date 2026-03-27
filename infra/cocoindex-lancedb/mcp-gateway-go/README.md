# MCP gateway (Go)

Stdlib replacement for `../mcp_gateway.py`: authenticates workers with `GATEWAY_WORKER_TOKEN`, blocks admin MCP tools, forwards to the indexer with `GATEWAY_ADMIN_TOKEN`.

## Build

```bash
docker build -t hive-mcp-gateway-go:latest .
```

## Run

Same environment variables as the Python gateway (`GATEWAY_WORKER_TOKEN`, `GATEWAY_ADMIN_TOKEN`, `GATEWAY_INDEXER_URL`). Default listen address `:9090` (`LISTEN_ADDR`).

## Operator note

Point `HiveIndexer` / worker MCP image at this binary when you want to drop the FastAPI edge. Behavior matches the Python service for `/health`, `/mcp` (SSE), and `/mcp/message`.
