# Hive DocIndex API — slim image (queue + LanceDB + embeddings client; no Docling/PyTorch).
#
# Security: dependencies installed from hash-locked requirements-api.lock (pip-compile --generate-hashes).
# Plain uvicorn keeps hash-locked installs valid; optional uvloop/httptools via uvicorn[standard] is a dev-only path.
#
# Usage:
#   docker build -t docindex:latest .
#   docker run --rm -p 8082:8082 \
#     -e DOCINDEX_API_TOKEN=<token> \
#     -e DOCINDEX_USE_WORKER_QUEUE=true \
#     -e DOCINDEX_REDIS_URL=redis://queue:6379/0 \
#     -v /path/to/docs:/data/docs:ro \
#     -v docindex-lancedb:/data/lancedb \
#     docindex:latest

FROM python:3.12-slim AS deps

WORKDIR /deps

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-api.lock .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements-api.lock

FROM python:3.12-slim

LABEL org.opencontainers.image.title="Hive DocIndex API"
LABEL org.opencontainers.image.description="Slim DocIndex API (LanceDB + job queue; parser runs in worker image)"
LABEL org.opencontainers.image.source="https://github.com/enkom/hive-infra"

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data/docs /data/lancedb /app /tmp && \
    chown -R 65534:65534 /data /app /tmp

COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

COPY --chown=65534:65534 \
    docindex_server.py \
    auth.py \
    docindex_jobs.py \
    docindex_constants.py \
    /app/

WORKDIR /app
ENV HOME=/tmp
USER 65534:65534

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8082/health || exit 1

ENTRYPOINT ["python", "docindex_server.py"]
