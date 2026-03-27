# Model gateway

OpenAI-compatible router that forwards requests to vLLM, SGLang, LM Studio proxy, or cloud backends by model id. See [control-plane/doc/MODEL-GATEWAY.md](../../control-plane/doc/MODEL-GATEWAY.md) for the spec and [control-plane/doc/K3S-LLM-DEPLOYMENT.md](../../control-plane/doc/K3S-LLM-DEPLOYMENT.md) for deploy order. To use **Bifrost** as the gateway, see [BIFROST-INTEGRATION.md](BIFROST-INTEGRATION.md), [bifrost/](bifrost/) (Helm values example + NetworkPolicy), and [BIFROST-RUNBOOK.md](BIFROST-RUNBOOK.md).

## Build and run locally

```bash
pip install -r requirements.txt
export CONFIG_PATH=./models.json   # or MODELS_JSON='{"models":[...]}'
python app.py
```

## Docker

```bash
docker build -t model-gateway:latest .
docker run -p 8080:8080 -v $(pwd)/models.json:/etc/model-gateway/models.json:ro model-gateway:latest
```

## Kubernetes

1. Create the ConfigMap with your model list (edit `k8s/configmap.yaml` or use your own `models.json`).
2. Build and load the image (e.g. `docker build -t model-gateway:latest .` and import into kind/k3s).
3. Apply: `kubectl apply -f k8s/configmap.yaml -f k8s/deployment.yaml`.

Workers then use `HIVE_MODEL_GATEWAY_URL=http://model-gateway:8080/v1` (same namespace) or `http://model-gateway.<namespace>.svc.cluster.local:8080/v1`.

## Config format

JSON with a `models` array. Each entry: `id`, `base_url`, optional `api_key_env` (environment variable name for the backend API key).
