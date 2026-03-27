# Reference model training runner (HTTP stub)

Minimal process that accepts Hive’s **dispatch** POST and completes the loop by calling Hive’s **model-training-callback**. Use as a template for real trainers (e.g. [AgentScope](https://github.com/agentscope-ai/agentscope) tuners on GPU nodes).

## Contract (dispatch body from Hive)

JSON fields (typical):

- `hiveTrainingRunId` (uuid)
- `companyId` (uuid)
- `proposedModelSlug` (string)
- `runnerKind` (e.g. `http_json`)
- `datasetExportUrl` — `GET` with `Authorization: Bearer <callbackToken>` returns NDJSON (`heartbeat_run` lines, then one `cost_aggregate` summary from `cost_events`)
- `callbackUrl` — `POST` with same Bearer and JSON body
- `callbackToken` — per-run secret; treat as sensitive

## Callback body

`POST` to `callbackUrl` with header `Authorization: Bearer <callbackToken>` and JSON:

```json
{
  "runId": "<hiveTrainingRunId>",
  "status": "succeeded",
  "resultBaseUrl": "https://your-openai-compatible-serving/v1",
  "resultMetadata": { "eval": { "metrics": { "accuracy": 0.91 } } }
}
```

Statuses: `running`, `succeeded`, `failed`. For `succeeded`, `resultBaseUrl` is required.

## Stub runner

```bash
python stub_runner.py
```

Set `HIVE_REFERENCE_RUNNER_PORT=8099`. Configure the company or deployment **`model_training_runner_url`** to `http://<host>:8099/train` (or whatever path you map).

This stub does **not** train; it echoes success so operators can verify dispatch, dataset export, callback, and board **promote** end-to-end.

## Security

- Run behind TLS and network policies in production.
- Do not log `callbackToken`.
- Validate `resultBaseUrl` against your allowlist before promotion in real runners.
