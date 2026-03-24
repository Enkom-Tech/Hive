# Model gateway spec

Thin OpenAI-compatible router so Hive and drones use a single URL for LLM inference. Backends can be vLLM, SGLang, LM Studio (e.g. via proxy), or cloud APIs.

## Contract

- **Endpoints:** HTTP service exposing OpenAI-compatible `/v1/chat/completions` and `/v1/completions`. Forward request body and relevant headers to the backend selected by model id.
- **Config:** Registry of models (e.g. `models.yaml` or ConfigMap). Each entry: `id` (model name used by clients), `base_url` (backend base URL, e.g. `http://vllm-llama:8000/v1`), optional `api_key_env` (env var name for API key for that backend).
- **Routing:** On each request, read `model` from the request; look up the backend for that id; proxy to `base_url` with the same path and body. Return the backend response.

## Single env for Hive

Workers (and thus agents) get one base URL, e.g. `HIVE_MODEL_GATEWAY_URL=http://model-gateway:8080/v1`. All model requests from the drone/executor use this URL; the gateway routes by model id.

## Example config (models.yaml)

```yaml
models:
  - id: lmstudio:qwen2.5-7b
    base_url: http://lmstudio-proxy:1234/v1
  - id: vllm:llama-3.1-8b
    base_url: http://vllm-llama:8000/v1
  - id: sglang:llama-3.1-8b-structured
    base_url: http://sglang-structured:3000/v1
  - id: openai:gpt-4.1-mini
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
```

## Deployment

See [K3S-LLM-DEPLOYMENT.md](K3S-LLM-DEPLOYMENT.md) and `infra/model-gateway/` for the deployable app and k8s manifests.
