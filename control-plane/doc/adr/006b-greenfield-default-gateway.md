# ADR 006b: Greenfield default — Bifrost as production LLM edge

## Status

Accepted (supplements [006-bifrost-model-gateway.md](006-bifrost-model-gateway.md)).

## Context

Hive has no production deployments yet. Operating **both** `infra/model-gateway-go` and Bifrost as parallel edges doubles virtual-key formats (`hive_gvk_*` vs `sk-bf-*`), sync paths, metering, and incident surface. ADR 006 already recommends Bifrost with **`allowDirectKeys: false`** and **`is_vk_mandatory: true`** for production multi-tenant.

## Decision

1. **Greenfield and new production clusters** standardize on **Bifrost** as the **only** OpenAI-compatible LLM edge for managed workers. Board minting uses **`sk-bf-*`** when `hive_deployments.model_gateway_backend` is **`bifrost`** (see migrations and [`MODEL-GATEWAY.md`](../MODEL-GATEWAY.md)).
2. **`infra/model-gateway-go`** is the **reference implementation** of the router contract and the **lab / local-dev / exception** path. It is **not** deployed in greenfield production unless security architecture signs off an **exception** (documented in the environment runbook: reason, risk owner, rollback).
3. **Exception process:** To run the Go router in production, record: (a) why Bifrost is infeasible, (b) confirmation that `model_gateway_backend` is **`hive_router`** for affected deployments, (c) workers use **`hive_gvk_*`** only, (d) no Bifrost with `allowDirectKeys: true` in front of those tokens.

## Consequences

- Default deployment row and column default for **`model_gateway_backend`** trend to **`bifrost`** (see migration `0045_*`). Installations that use **only** the Go router must set **`hive_router`** explicitly on their deployment row(s).
- Operators follow [`GREENFIELD-CHECKLIST.md`](../../../infra/model-gateway/bifrost/GREENFIELD-CHECKLIST.md) for ordering secrets, sync, and metering.

## References

- [006a — Credentials, sync, metering](006a-bifrost-credentials-metering.md)
- [`BIFROST-INTEGRATION.md`](../../../infra/model-gateway/BIFROST-INTEGRATION.md)
- [`GREENFIELD-CHECKLIST.md`](../../../infra/model-gateway/bifrost/GREENFIELD-CHECKLIST.md)
