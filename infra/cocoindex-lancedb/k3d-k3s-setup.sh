#!/bin/bash
set -e

# -----------------------------------------------------------------------------
# Hive + CocoIndex K3s Setup Script (March 2026)
# WSL2/K3d - Builds local images + deploys Hive operator pattern
# -----------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-hive-cocoindex}"
NAMESPACE="${NAMESPACE:-cocoindex}"

echo "🚀 Hive + CocoIndex K3s Cluster Setup"
echo "====================================="

# -----------------------------------------------------------------------------
# 1. Prerequisites + Local Images
# -----------------------------------------------------------------------------
check_prereqs() {
    echo "[1/6] Checking prerequisites..."
    
    for cmd in k3d kubectl docker; do
        command -v "$cmd" >/dev/null || { 
            echo "❌ Missing $cmd"; exit 1 
        }
    done
    
    # Build local images
    echo "[1/6] Building local images..."
    docker build -t cocoindex:latest -f Dockerfile .
    docker build -t lancedb-server:latest -f Dockerfile.lancedb .
    
    echo "✅ Prerequisites OK"
}

# -----------------------------------------------------------------------------
# 2. Create K3d Cluster (2026 versions)
# -----------------------------------------------------------------------------
create_cluster() {
    echo "[2/6] Creating K3s cluster..."
    
    k3d cluster delete "$CLUSTER_NAME" || true
    k3d cluster create "$CLUSTER_NAME" \
        --image rancher/k3s:v1.31.4-k3s1 \
        --servers 1 --agents 1 \
        --port '8080:80@loadbalancer' \
        --port '8890:8890@loadbalancer' \
        --k3s-arg "--disable=traefik@server:0" \
        --volume "${SCRIPT_DIR}/myrepo:/data/repos@server:0" \
        --volume "${SCRIPT_DIR}/models:/data/models@agent:0" \
        --wait
    
    kubectl config use-context "k3d-$CLUSTER_NAME"
    kubectl create ns "$NAMESPACE" || true
}

# -----------------------------------------------------------------------------
# 3. Storage + GPU (NVIDIA device plugin)
# -----------------------------------------------------------------------------
setup_infra() {
    echo "[3/6] Installing infrastructure..."
    
    # StorageClass
    cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
provisioner: rancher.io/local-path
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
EOF
    
    # NVIDIA GPU (WSL2/K3s)
    kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.15.0/nvidia-device-plugin.yml
    kubectl wait --for=condition=Available -n kube-system deployment/nvidia-device-plugin-ds --timeout=60s
}

# -----------------------------------------------------------------------------
# 4. Deploy Services (Separate LanceDB server)
# -----------------------------------------------------------------------------
deploy_services() {
    echo "[4/6] Deploying CocoIndex stack..."
    
    # DragonflyDB (Hive coordination)
    kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dragonfly
  namespace: $NAMESPACE
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dragonfly
  template:
    metadata:
      labels:
        app: dragonfly
    spec:
      containers:
      - name: dragonfly
        image: dragonflydb/dragonfly:latest
        ports:
        - containerPort: 6379
        command: ["--bind=0.0.0.0"]
---
apiVersion: v1
kind: Service
metadata:
  name: dragonfly
  namespace: $NAMESPACE
spec:
  selector:
    app: dragonfly
  ports:
  - port: 6379
    targetPort: 6379
EOF
    
    # LanceDB Server (REST API)
    kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lancedb-server
  namespace: $NAMESPACE
spec:
  replicas: 1
  selector:
    matchLabels:
      app: lancedb-server
  template:
    metadata:
      labels:
        app: lancedb-server
    spec:
      containers:
      - name: lancedb
        image: lancedb-server:latest
        ports:
        - containerPort: 8000
        env:
        - name: LANCE_DB_URI
          value: /data/lancedb
        volumeMounts:
        - name: storage
          mountPath: /data/lancedb
      volumes:
      - name: storage
        persistentVolumeClaim:
          claimName: lancedb-storage
---
apiVersion: v1
kind: Service
metadata:
  name: lancedb-server
  namespace: $NAMESPACE
spec:
  selector:
    app: lancedb-server
  ports:
  - port: 8000
    targetPort: 8000
EOF
    
    # PVC
    kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lancedb-storage
  namespace: $NAMESPACE
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 50Gi
EOF
}

# -----------------------------------------------------------------------------
# 5. Hive WorkerPool CRD (Simplified)
# -----------------------------------------------------------------------------
deploy_hive_workers() {
    echo "[5/6] Deploying Hive WorkerPool..."
    
    # Mock HiveWorkerPool CRD
    cat <<EOF | kubectl apply -f -
apiVersion: hive.ai/v1alpha1
kind: HiveWorkerPool
metadata:
  name: cocoindex-workers
  namespace: $NAMESPACE
spec:
  replicas: 2
  image: cocoindex:latest
  env:
  - name: LANCEDB_URL
    value: "http://lancedb-server.$NAMESPACE.svc.cluster.local:8000"
  - name: EMBEDDING_URL  
    value: "http://llama-embeddings.$NAMESPACE.svc.cluster.local:8080"
  - name: REPOS_PATH
    value: "/data/repos"
  volumes:
  - name: repos
    hostPath:
      path: /data/repos
EOF
}

# -----------------------------------------------------------------------------
# 6. Status + Port-forward
# -----------------------------------------------------------------------------
print_status() {
    echo "[6/6] ✅ Setup Complete!"
    echo ""
    
    kubectl get nodes -o wide
    kubectl get pods -n "$NAMESPACE" -w
    echo ""
    echo "🌐 Port-forward:"
    echo "kubectl port-forward -n $NAMESPACE svc/lancedb-server 8890:8000"
    echo "kubectl port-forward -n $NAMESPACE deployment/cocoindex 8080:8080"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
case "${1:-all}" in
    all) check_prereqs && create_cluster && setup_infra && deploy_services && deploy_hive_workers && print_status ;;
    clean) k3d cluster delete "$CLUSTER_NAME" || true ;;
    *) echo "Usage: $0 [all|clean]"; exit 1 ;;
esac