# LLM manifests (optional)

Example Kubernetes manifests for in-cluster LLM inference and LM Studio proxy. **Optional;** used when following [control-plane/doc/K3S-LLM-DEPLOYMENT.md](../../../control-plane/doc/K3S-LLM-DEPLOYMENT.md). Not managed by the ArgoCD app-of-apps by default.

## Contents

| File | Purpose |
|------|---------|
| `vllm-llama.yaml` | vLLM Deployment + Service (Llama 3 8B). Uncomment `nodeSelector` and `nvidia.com/gpu` for GPU. |
| `sglang-structured.yaml` | SGLang Deployment + Service for structured output (GPU). |
| `lmstudio-proxy.yaml` | Service + hostNetwork proxy so the cluster can reach an SSH-reverse-tunneled LM Studio on the desktop. Set `nodeSelector.kubernetes.io/hostname` to the k3s server node name. |

## Apply order

1. If using GPU nodes: label and taint nodes; install NVIDIA or ROCm device plugin (see K3S-LLM-DEPLOYMENT.md).
2. `kubectl apply -f vllm-llama.yaml` (and optionally `sglang-structured.yaml`).
3. If using LM Studio via tunnel: edit `lmstudio-proxy.yaml` to set the correct node name, then `kubectl apply -f lmstudio-proxy.yaml`.
4. Deploy the model gateway (see `infra/model-gateway/`) and point workers at it.

Apply from repo root: `kubectl apply -f infra/manifests/llm/` (or apply files individually).
