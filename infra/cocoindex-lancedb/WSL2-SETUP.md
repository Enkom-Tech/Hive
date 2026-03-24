## 8. WSL2 Notes (Go 1.26+, k3d)

# WSL2 Setup Guide for Hive + CocoIndex

This guide covers setting up the complete Hive + CocoIndex stack on WSL2 with k3d.

## Prerequisites

### 1. WSL2 Installation

```powershell
# In PowerShell (Administrator)
wsl --install -d Ubuntu-24.04
wsl --set-default-version 2
```

### 2. WSL2 Configuration

Create/edit `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
memory=32GB
processors=8
swap=8GB
swapFile=C:\temp\wsl-swap.vhdx
localhostForwarding=true
autoProxy=true
firewall=true
gpuSupport=true
```

### 3. Ubuntu Setup in WSL2

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install essential packages
sudo apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common \
    apt-transport-https
```

## Docker Installation (WSL2)

### Option 1: Docker Desktop (Recommended)

1. Install Docker Desktop on Windows
2. Enable WSL2 backend in Docker Desktop settings
3. Enable integration with your WSL2 distro

### Option 2: Docker CE (Linux native)

```bash
# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker

# Start Docker service
sudo service docker start
```

## Kubernetes Tools (k3d + kubectl + Helm)

### k3d Installation

```bash
# Install k3d
wget -q -O - https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# Verify installation
k3d version
```

### kubectl Installation

```bash
# Download and install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Verify
kubectl version --client
```

### Helm Installation

```bash
# Install Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Verify
helm version
```

## Go 1.26+ Installation

```bash
# Download Go 1.26 (or latest)
GO_VERSION="1.26.0"
wget https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz

# Remove old Go and install new version
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
rm go${GO_VERSION}.linux-amd64.tar.gz

# Add to PATH
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
echo 'export GOPATH=$HOME/go' >> ~/.bashrc
echo 'export PATH=$PATH:$GOPATH/bin' >> ~/.bashrc
source ~/.bashrc

# Verify
go version
```

## GPU Support (NVIDIA CUDA)

### Install NVIDIA Container Toolkit

```bash
# Add NVIDIA package repositories
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list

# Install nvidia-container-toolkit
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# Configure Docker
echo '{
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  }
}' | sudo tee /etc/docker/daemon.json

# Restart Docker
sudo service docker restart
```

### WSL2 CUDA Setup

```bash
# Install CUDA toolkit (if needed for local development)
wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-wsl-ubuntu.pin
sudo mv cuda-wsl-ubuntu.pin /etc/apt/preferences.d/cuda-repository-pin-600
wget https://developer.download.nvidia.com/compute/cuda/12.6.0/local_installers/cuda-repo-wsl-ubuntu-12-6-local_12.6.0-1_amd64.deb
sudo dpkg -i cuda-repo-wsl-ubuntu-12-6-local_12.6.0-1_amd64.deb
sudo cp /var/cuda-repo-wsl-ubuntu-12-6-local/cuda-*-keyring.gpg /usr/share/keyrings/
sudo apt-get update
sudo apt-get -y install cuda
```

## Hive Control Plane Setup

### Prerequisites

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.bashrc

# Install PostgreSQL (or use Docker)
sudo apt-get install -y postgresql postgresql-contrib

# Start PostgreSQL
sudo service postgresql start

# Create Hive database
sudo -u postgres psql -c "CREATE USER hive WITH PASSWORD 'hive';"
sudo -u postgres psql -c "CREATE DATABASE hive OWNER hive;"
```

### Run Control Plane

```bash
cd /mnt/c/Users/Xtreme-W/Transfer/Enkom/Enkom/Git/Hive-Infra/control-plane

# Install dependencies
pnpm install

# Set environment variables
export DATABASE_URL="postgres://hive:hive@localhost:5432/hive"
export BETTER_AUTH_SECRET="dev-secret-for-testing-12345"

# Run development server
pnpm dev
```

## Quick Start: Full Stack

### 1. Standalone Docker Compose

```bash
cd /mnt/c/Users/Xtreme-W/Transfer/Enkom/Enkom/Git/Hive-Infra/infra/cocoindex-lancedb

# Download Qwen3-Embedding-8B GGUF model
mkdir -p models
cd models

# Option 1: Download from HuggingFace (requires huggingface-cli)
pip install huggingface-hub
huggingface-cli download Qwen/Qwen3-Embedding-8B-GGUF qwen3-embedding-8b-Q4_K_M.gguf --local-dir .

# Option 2: Direct download
wget https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/qwen3-embedding-8b-Q4_K_M.gguf

cd ..

# Clone sample repository
mkdir -p myrepo
cd myrepo
git clone --depth 1 https://github.com/fastapi/fastapi.git
cd ..

# Start services
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs -f

# Run tests
./test-commands.sh
```

### 2. K3d Cluster with Hive Integration

```bash
cd /mnt/c/Users/Xtreme-W/Transfer/Enkom/Enkom/Git/Hive-Infra/infra/cocoindex-lancedb

# Make script executable
chmod +x k3d-k3s-setup.sh

# Create full cluster
./k3d-k3s-setup.sh all

# Or step by step:
# ./k3d-k3s-setup.sh cluster-only  # Just k3s cluster
# ./k3d-k3s-setup.sh cocoindex-only  # Just CocoIndex on existing cluster

# Check cluster
kubectl get nodes
kubectl get pods -n cocoindex
kubectl get pods -n hive-system

# Port forward for local access
kubectl port-forward -n cocoindex svc/cocoindex 8080:8080 &
kubectl port-forward -n cocoindex svc/lancedb 8890:8000 &

# Run tests
COCOINDEX_URL=http://localhost:8080 ./test-commands.sh

# Delete cluster when done
./k3d-k3s-setup.sh delete
```

## Troubleshooting

### Docker Permission Issues

```bash
# If you get permission denied errors
sudo usermod -aG docker $USER
newgrp docker

# Or use sudo (not recommended for regular use)
sudo docker ps
```

### k3d Cluster Access Issues

```bash
# Fix kubeconfig
k3d kubeconfig merge $CLUSTER_NAME --kubeconfig-switch-context

# Or manually
export KUBECONFIG="$(k3d kubeconfig write $CLUSTER_NAME)"
```

### GPU Not Available in Containers

```bash
# Check nvidia-smi
nvidia-smi

# Test GPU in container
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi

# If using WSL2, ensure GPU support is enabled in .wslconfig
gpuSupport=true
```

### Memory Issues

```bash
# Increase WSL2 memory in .wslconfig
memory=32GB

# Monitor memory usage in WSL2
free -h
htop

# Restart WSL2 to apply changes
wsl --shutdown
```

### Port Conflicts

```bash
# Check what's using port 8080
sudo netstat -tlnp | grep 8080

# Kill process using port
sudo kill -9 <PID>

# Or use different ports in docker-compose.yml
```

### Slow File Performance

```bash
# Move project to WSL2 filesystem (not Windows mounted)
cd ~
git clone <repo>
# Much faster than /mnt/c/...

# For best performance, keep Docker volumes in WSL2
# Edit docker-compose.yml to use named volumes instead of bind mounts where possible
```

## Development Workflow

### Rebuilding Containers

```bash
# Rebuild all
docker-compose up -d --build

# Rebuild specific service
docker-compose up -d --build cocoindex

# No cache rebuild
docker-compose build --no-cache
```

### Logs and Debugging

```bash
# Follow logs
docker-compose logs -f

# Specific service
docker-compose logs -f cocoindex

# Shell into container
docker-compose exec cocoindex /bin/bash

# Check LanceDB contents
docker-compose exec lancedb python -c "import lancedb; db = lancedb.connect('/data/lancedb'); t = db.open_table('code_embeddings'); print(t.count_rows())"
```

### Updating Models

```bash
# Stop services
docker-compose down

# Download new model to ./models/
cd models
wget https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/qwen3-embedding-8b-Q6_K.gguf

# Update docker-compose.yml with new model name
# LLAMA_ARG_MODEL=/models/qwen3-embedding-8b-Q6_K.gguf

# Restart
docker-compose up -d
```

## Production Considerations

### Security

- Use secrets management (Kubernetes secrets, Vault)
- Enable TLS for all endpoints
- Restrict network access with NetworkPolicies
- Use read-only root filesystems where possible

### Monitoring

```bash
# Deploy Prometheus + Grafana
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/bundle.yaml

# Deploy for LanceDB metrics
kubectl apply -f k8s/monitoring.yaml
```

### Backup

```bash
# LanceDB backup script
kubectl exec -n cocoindex sts/lancedb -- tar czf /tmp/backup.tar.gz /data/lancedb
kubectl cp cocoindex/lancedb-0:/tmp/backup.tar.gz ./backup.tar.gz
```

## Resources

- [k3d Documentation](https://k3d.io/)
- [LanceDB Documentation](https://lancedb.github.io/lancedb/)
- [llama.cpp Server](https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md)
- [Qwen3-Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-8B)
- [Hive Documentation](https://github.com/hive-ai/hive)
