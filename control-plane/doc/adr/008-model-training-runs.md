# ADR 008: Model training runs and runner contract

## Status

Accepted (2026-03)

## Context

Hive orchestrates autonomous agent companies. Identities should be able to improve their effective model over time via external training jobs (fine-tuning, RL, or AgentScope-style tuners) without embedding Python frameworks in the control plane.

## Decision

- Persist **`model_training_runs`** per company with a per-run **callback token** (stored as SHA-256). Training runners receive the plaintext token once in the dispatch payload and send `Authorization: Bearer <token>` to `POST /api/internal/hive/model-training-callback`. This route is **always** mounted under `/api/internal/hive` so token-only deployments work. The optional **`HIVE_INTERNAL_OPERATOR_SECRET`** (used for metering and gateway lookup) may also authorize callbacks for break-glass operations when set.
- **Dispatch** is an HTTP POST from the API to `companies.model_training_runner_url` or `hive_deployments.model_training_runner_url` (company overrides deployment). Payload includes dataset export URL and callback URL; URLs require **`apiPublicBaseUrl`** (e.g. auth public base URL) to be set or dispatch is skipped.
- **Promotion** upserts a company-scoped **`inference_models`** row and optionally sets **`agents.runtime_config.defaultModelSlug`** for the run’s agent. Operators still sync the model gateway using existing tooling ([`infra/model-gateway/SYNC-INFERENCE-CONFIG.md`](../../../infra/model-gateway/SYNC-INFERENCE-CONFIG.md)).
- **Dataset export** (`GET .../dataset-export`) streams redacted NDJSON: one line per recent **`heartbeat_run`** (issue context when present), then a closing **`cost_aggregate`** line with totals and up to 50 `(model, provider)` buckets from **`cost_events`** in a time window (default last 90 days; optional bounds `costOccurredAfter` / `costOccurredBefore` ISO datetimes in `dataset_filter_spec`). Scoped to the company and, when the run has `agent_id`, to that agent’s costs. Authorized via the per-run callback token or board permission **`models:train`**.
- **Governance:** `companies.require_approval_for_model_promotion` requires an approved **`promote_model`** approval whose payload references `modelTrainingRunId`. Company and agent **`identity_self_tune_policy`** columns reserve future worker-initiated automation (`disabled` | `approval_required` | `auto_dispatch`).

## Threats

| Risk | Mitigation |
|------|------------|
| Callback forgery | Per-run secret + hash; optional operator secret; TLS in production |
| SSRF / unsafe `result_base_url` | Same operational discipline as manual inference catalog entries; validate URLs in deployment policy |
| Data exfiltration via export | Callback token required for runner path; board path requires `models:train`; no secrets in export schema |

## Consequences

- Admin membership (and instance admin bypass) includes **`models:train`**.
- Runners remain **customer-operated**; Hive tracks state and promotion only.
