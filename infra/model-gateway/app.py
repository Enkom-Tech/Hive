"""
Minimal OpenAI-compatible router. Reads models from CONFIG_PATH (JSON/YAML) or MODELS_JSON env;
proxies /v1/chat/completions and /v1/completions to the backend for the request's model id.
"""
import os
import json
import httpx
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="model-gateway", version="0.1.0")

CONFIG_PATH = os.getenv("CONFIG_PATH", "/etc/model-gateway/models.json")
MODELS_JSON = os.getenv("MODELS_JSON")


def load_models():
    if MODELS_JSON:
        return json.loads(MODELS_JSON)
    p = Path(CONFIG_PATH)
    if p.exists():
        with open(p) as f:
            data = json.load(f)
            return data.get("models", data) if isinstance(data, dict) else data
    return []


def get_models():
    try:
        return load_models()
    except Exception as e:
        return []


@app.get("/v1/models")
async def list_models():
    models = get_models()
    return {
        "object": "list",
        "data": [
            {"id": m["id"], "object": "model", "created": 0}
            for m in models
        ],
    }


def find_backend(model_id: str):
    for m in get_models():
        if m.get("id") == model_id:
            base = m.get("base_url", "").rstrip("/")
            api_key_env = m.get("api_key_env")
            api_key = os.getenv(api_key_env) if api_key_env else None
            return base, api_key
    return None, None


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy(path: str, request: Request):
    body = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
    payload = {}
    if body:
        try:
            payload = json.loads(body)
        except Exception:
            pass
    model_id = payload.get("model") or request.query_params.get("model")
    if not model_id:
        raise HTTPException(status_code=400, detail="Missing model")
    base_url, api_key = find_backend(model_id)
    if not base_url:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")
    url = f"{base_url}/v1/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.request(
            request.method,
            url,
            content=body,
            headers=headers,
            params=request.query_params,
        )
    return JSONResponse(content=r.json(), status_code=r.status_code)


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
