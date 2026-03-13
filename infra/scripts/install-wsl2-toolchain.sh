#!/usr/bin/env bash
# Install toolchain for Hive infra: make ci and make e2e in WSL2.
# Usage: run from infra/ or repo root. Uses sudo for apt and /usr/local/go.
# After running, ensure PATH includes /usr/local/go/bin and $(go env GOPATH)/bin (this script echoes reminders).

set -e
GO_VERSION="${GO_VERSION:-1.26.1}"
ARCH="${ARCH:-linux-amd64}"

echo "=== Base system and Go ${GO_VERSION} ==="
sudo apt update
sudo apt install -y build-essential wget
if ! command -v go &>/dev/null || [[ $(go version | cut -d' ' -f3 | sed 's/go//') != "${GO_VERSION}" ]]; then
  wget -q "https://go.dev/dl/go${GO_VERSION}.${ARCH}.tar.gz" -O /tmp/go.tar.gz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tar.gz
  rm -f /tmp/go.tar.gz
fi
export PATH="/usr/local/go/bin:$PATH"
if ! grep -q '/usr/local/go/bin' ~/.bashrc 2>/dev/null; then
  echo 'export PATH="/usr/local/go/bin:$PATH"' >> ~/.bashrc
fi
go version

echo "=== GOPATH/bin on PATH ==="
GOPATH_BIN="$(go env GOPATH)/bin"
export PATH="$PATH:$GOPATH_BIN"
if ! grep -q 'GOPATH.*bin' ~/.bashrc 2>/dev/null; then
  echo "export PATH=\"\$PATH:\$(go env GOPATH)/bin\"" >> ~/.bashrc
fi

echo "=== Docker (optional: use Docker Desktop with WSL2 backend instead) ==="
if ! command -v docker &>/dev/null; then
  sudo apt install -y docker.io
  sudo systemctl start docker 2>/dev/null || true
  sudo usermod -aG docker "$USER" 2>/dev/null || true
  echo "  Log out and back in (or run 'newgrp docker') for docker group to take effect."
else
  echo "  Docker already present."
fi

echo "=== kubectl ==="
if ! command -v kubectl &>/dev/null; then
  sudo apt install -y kubectl 2>/dev/null || echo "  Install kubectl manually: https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/"
else
  echo "  kubectl already present."
fi

echo "=== k3d ==="
if ! command -v k3d &>/dev/null; then
  curl -sL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | TAG=v5.3.0 bash
else
  echo "  k3d already present."
fi

echo "=== Lint and security tools ==="
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
go install github.com/yannh/kubeconform/cmd/kubeconform@latest
go install github.com/securego/gosec/v2/cmd/gosec@latest
go install golang.org/x/vuln/cmd/govulncheck@latest

echo "=== envtest (operator integration tests) ==="
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
ENVTEST_PATH=$(setup-envtest use 1.28.x -p path 2>/dev/null || true)
if [[ -n "$ENVTEST_PATH" ]]; then
  export KUBEBUILDER_ASSETS="$ENVTEST_PATH"
  if ! grep -q 'KUBEBUILDER_ASSETS' ~/.bashrc 2>/dev/null; then
    echo "export KUBEBUILDER_ASSETS='$ENVTEST_PATH'" >> ~/.bashrc
  fi
  echo "  envtest 1.28 at KUBEBUILDER_ASSETS"
else
  echo "  Run 'setup-envtest use 1.28.x -p path' and export KUBEBUILDER_ASSETS for operator integration tests."
fi

echo "=== Done ==="
echo "Ensure PATH includes: /usr/local/go/bin and $(go env GOPATH)/bin"
echo "Verify: go version, make -v, docker version, k3d version, kubectl version --client, golangci-lint --version, kubeconform -v"
