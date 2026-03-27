# Secrets Provisioning

Hive services require several secrets at runtime. None of these values should ever be committed to git — not even as placeholders. This document covers four provisioning patterns ordered by operational complexity.

The secrets relevant to DocIndex and CocoIndex are:

| Secret name | Key | Used by |
|---|---|---|
| `docindex-api-token` | `token` | DocIndex API auth |
| `docindex-queue-creds` | `redis-url` | DocIndex API + worker Redis connection |
| `docindex-job-signing-key` | `key` | DocIndex API + worker HMAC job signing |
| `cocoindex-api-token` | `token` | CocoIndex API auth |

Generate strong random values before provisioning:

```bash
openssl rand -hex 32
```

---

## 1. kubectl (no external tooling)

The simplest option. Secrets live only in etcd. Suitable for single-cluster setups where etcd encryption-at-rest is configured.

```bash
# DocIndex API token
kubectl -n docindex create secret generic docindex-api-token \
  --from-literal=token="$(openssl rand -hex 32)"

# DocIndex Redis queue credentials
# Replace PASSWORD with the value you set in docindex-dragonfly's requirepass arg
kubectl -n docindex create secret generic docindex-queue-creds \
  --from-literal=redis-url="rediss://:PASSWORD@docindex-dragonfly.docindex.svc.cluster.local:6380/0"

# DocIndex job signing key
kubectl -n docindex create secret generic docindex-job-signing-key \
  --from-literal=key="$(openssl rand -hex 32)"

# CocoIndex API token
kubectl -n default create secret generic cocoindex-api-token \
  --from-literal=token="$(openssl rand -hex 32)"
```

To update a secret without recreating it:

```bash
kubectl -n docindex patch secret docindex-api-token \
  --type='json' \
  -p='[{"op":"replace","path":"/data/token","value":"'$(openssl rand -hex 32 | base64)'"}]'
```

---

## 2. Sealed Secrets

[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) encrypts a Secret manifest with a cluster-specific key so the ciphertext is safe to commit to git.

Install the controller:

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system
```

Seal a secret:

```bash
kubectl -n docindex create secret generic docindex-api-token \
  --from-literal=token="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml \
  | kubeseal --format yaml > infra/docindex-lancedb/k8s/sealed-api-token.yaml
```

Apply the sealed secret (the controller decrypts it in-cluster):

```bash
kubectl apply -f infra/docindex-lancedb/k8s/sealed-api-token.yaml
```

The `sealed-*.yaml` files are safe to commit; they cannot be decrypted without the cluster's private key.

---

## 3. External Secrets Operator

[External Secrets Operator](https://external-secrets.io/) syncs secrets from an external store (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, etc.) into Kubernetes Secrets.

Install the operator:

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace
```

Create a `SecretStore` pointing at your provider, then an `ExternalSecret` that maps external keys to a K8s Secret:

```yaml
# infra/docindex-lancedb/k8s/external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: docindex-api-token
  namespace: docindex
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend     # name of your SecretStore
    kind: SecretStore
  target:
    name: docindex-api-token
    creationPolicy: Owner
  data:
    - secretKey: token
      remoteRef:
        key: hive/docindex
        property: api_token
```

The operator reconciles the K8s Secret from the external store on the configured interval and rotates it automatically when the upstream value changes.

---

## 4. Vault Agent Injector

The [Vault Agent Injector](https://developer.hashicorp.com/vault/docs/platform/k8s/injector) uses a mutating webhook to inject a Vault Agent sidecar that writes secrets to a shared in-memory volume at pod startup.

Configure the pod with annotations:

```yaml
# Add to pod spec metadata.annotations in docindex Deployment
annotations:
  vault.hashicorp.com/agent-inject: "true"
  vault.hashicorp.com/role: "docindex"
  vault.hashicorp.com/agent-inject-secret-token: "hive/data/docindex"
  vault.hashicorp.com/agent-inject-template-token: |
    {{- with secret "hive/data/docindex" -}}
    {{ .Data.data.api_token }}
    {{- end }}
```

The secret is written to `/vault/secrets/token` inside the pod. Update the application to read from the file path instead of an environment variable, or use an init container to export it as an env var.

This pattern avoids storing secret values in etcd entirely — the agent fetches and renews directly from Vault.

---

## Comparison

| Pattern | Git-safe | Auto-rotation | External dependency | Complexity |
|---|---|---|---|---|
| kubectl | No | Manual | None | Low |
| Sealed Secrets | Yes | Manual | Controller | Low |
| External Secrets Operator | Yes | Yes | Operator + backend | Medium |
| Vault Agent Injector | Yes | Yes | Vault + injector | High |

For most Hive deployments starting out, **kubectl** with etcd encryption-at-rest is sufficient. Move to **External Secrets Operator** or **Vault Agent** once the secret count grows or automated rotation is required.
