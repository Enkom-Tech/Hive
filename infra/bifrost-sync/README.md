# bifrost-sync

Polls the Hive board **`GET /api/companies/:id/inference-router-config`** and reconciles Bifrost **`openai`** provider keys (names prefixed with **`hive-sync-`**).

## Compatibility (pin before production)

This repo validates the **Hive** side of the contract in unit tests. The **Bifrost** admin API (`GET`/`PUT /api/providers/openai`) is **version-sensitive**.

| Component | Version tracked in repo |
|-----------|-------------------------|
| Bifrost core / plugin API (metering) | `github.com/maximhq/bifrost/core v1.4.14` in [`../bifrost-hive-metering/go.mod`](../bifrost-hive-metering/go.mod) |
| Bifrost container image | Pin **`image.tag`** in your Helm values to the same major/minor line you tested (see [Bifrost releases](https://github.com/maximhq/bifrost/releases)). |

**Before relying on sync in production:**

1. Fetch OpenAPI for your pinned Bifrost version: [Bifrost docs index](https://docs.getbifrost.ai/llms.txt) → config/providers paths.
2. Compare **`PUT /api/providers/openai`** request body to what [`main.go`](main.go) builds (`mergeProviderKeys`). Adjust structs if upstream added required fields.
3. Run **`HIVE_BIFROST_SYNC_DRY_RUN=true`** against a staging Bifrost and inspect logged JSON.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HIVE_BIFROST_SYNC_BOARD_BASE_URL` | yes | Board API origin (no trailing slash) |
| `HIVE_BIFROST_SYNC_BOARD_TOKEN` | yes | Bearer JWT with access to listed companies |
| `HIVE_BIFROST_SYNC_COMPANY_IDS` | yes | Comma-separated UUIDs |
| `HIVE_BIFROST_SYNC_BIFROST_BASE_URL` | yes | Bifrost gateway root (no trailing slash) |
| `HIVE_BIFROST_SYNC_BIFROST_TOKEN` | yes | Governance/admin bearer for Bifrost API |
| `HIVE_BIFROST_SYNC_DRY_RUN` | no | `true` = log only |
| `HIVE_BIFROST_SYNC_ALLOWED_HOST_SUFFIXES` | no | Default `.svc.cluster.local,.svc` |
| `HIVE_BIFROST_SYNC_PROVIDER_KEY_VALUE` | no | Dummy provider key string for keyless backends |

## Kubernetes

See [`k8s/cronjob.example.yaml`](k8s/cronjob.example.yaml).

## Operational checklist

See [`../model-gateway/bifrost/GREENFIELD-CHECKLIST.md`](../model-gateway/bifrost/GREENFIELD-CHECKLIST.md) § Catalog sync.
