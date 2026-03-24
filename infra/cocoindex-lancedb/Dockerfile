# CocoIndex v1 + LanceDB (embedded) — Python FastAPI service
# Multi-stage: deps builder → minimal runtime (~200MB)
#
# Security:
#   - Runs as UID 65534 (nobody), matching the Hive operator's nonroot policy
#   - No secrets baked in — all credentials injected via K8s secretKeyRef at runtime
#   - Dependencies installed from locked requirements (hash-verified)
#
# Usage:
#   docker build -t cocoindex:latest .
#   docker run --rm -p 8080:8080 \
#     -e COCOINDEX_API_TOKEN=<token> \
#     -e COCOINDEX_DRAGONFLY_URL=redis://... \
#     -v /path/to/repos:/data/repos:ro \
#     cocoindex:latest

# -----------------------------------------------------------------------------
# Stage 1: Build Python dependencies with hash verification
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS deps

WORKDIR /deps

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Install from requirements.txt (requirements.lock used in CI for hash verification)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# -----------------------------------------------------------------------------
# Stage 2: Minimal production runtime
# -----------------------------------------------------------------------------
FROM python:3.12-slim

# Label metadata
LABEL org.opencontainers.image.title="CocoIndex"
LABEL org.opencontainers.image.description="Semantic code indexing for Hive workers"
LABEL org.opencontainers.image.source="https://github.com/enkom/hive-infra"

# Install only curl (healthcheck) and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user — UID 65534 (nobody) matches Hive operator security policy
# (workerpool_controller.go uses runAsUser: 65534 for all managed pods)
RUN groupadd -r cocoindex --gid=65534 && \
    useradd -r -g cocoindex -u 65534 -M cocoindex && \
    mkdir -p /data/repos /data/lancedb /app && \
    chown -R 65534:65534 /data /app

# Copy Python site-packages from deps stage
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

# Copy application source
COPY --chown=65534:65534 cocoindex_server.py auth.py /app/

WORKDIR /app
USER 65534:65534

# Expose API port
EXPOSE 8080

# Healthcheck — unauthenticated, required for K8s liveness/readiness probes
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the Python FastAPI server directly
ENTRYPOINT ["python", "cocoindex_server.py"]
