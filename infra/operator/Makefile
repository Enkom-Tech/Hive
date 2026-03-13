# Hive operator Makefile. Run from Linux/WSL2.

SHELL := /bin/bash
UNAME_S := $(shell uname -s 2>/dev/null)
ifeq ($(UNAME_S),Linux)
  # ok
else ifeq ($(UNAME_S),Darwin)
  # ok
else
  $(error "Operator build and tests require Linux or macOS (use WSL2 on Windows)")
endif

# Image
IMG ?= hive-operator:latest

# Get the currently used golang install path
GOROOT := $(shell go env GOROOT 2>/dev/null)
GOBIN := $(shell go env GOBIN 2>/dev/null)
ifeq ($(GOBIN),)
  GOBIN := $(shell go env GOPATH)/bin
endif
# envtest binaries for controller integration tests (run: go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest)
ENVTEST_ASSETS := $(shell PATH="$(GOBIN):$$PATH" setup-envtest use -p path 1.28.x 2>/dev/null)

.PHONY: all
all: build

.PHONY: lint
lint:
	$(GOBIN)/golangci-lint run ./...

# test-unit: api + internal packages only (no envtest). Controller integration tests need envtest and run in test-integration.
.PHONY: test-unit
test-unit:
	go test ./api/... ./internal/... -short -race -coverprofile=coverage.out -count=1

# test-integration: controller suite with envtest (etcd + kube-apiserver). Requires setup-envtest and KUBEBUILDER_ASSETS.
.PHONY: test-integration
test-integration:
	KUBEBUILDER_ASSETS='$(ENVTEST_ASSETS)' go test ./controllers/... -race -count=1

.PHONY: test
test: test-unit test-integration

.PHONY: generate
generate:
	@test -x $(GOBIN)/controller-gen || go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.13.0
	$(GOBIN)/controller-gen object:headerFile=hack/boilerplate.go.txt paths="./..."
	$(GOBIN)/controller-gen crd webhook rbac:roleName=manager-role output:crd:artifacts:config=config/crd/bases

.PHONY: manifests
manifests:
	@test -x $(GOBIN)/controller-gen || go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.13.0
	$(GOBIN)/controller-gen crd webhook rbac:roleName=manager-role output:crd:artifacts:config=config/crd/bases

.PHONY: docker-build
docker-build:
	docker build -t $(IMG) .

.PHONY: gosec
gosec:
	@test -x $(GOBIN)/gosec || go install github.com/securego/gosec/v2/cmd/gosec@latest
	$(GOBIN)/gosec ./...

.PHONY: govulncheck
govulncheck:
	@test -x $(GOBIN)/govulncheck || go install golang.org/x/vuln/cmd/govulncheck@latest
	$(GOBIN)/govulncheck ./...

.PHONY: clean
clean:
	go clean -testcache
	rm -f coverage.out
	rm -rf bin/

.PHONY: run
run:
	go run main.go
