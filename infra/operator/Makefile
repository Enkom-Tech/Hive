# Hive operator Makefile.
# Requires Go 1.22+ (repo uses 1.26). On Windows, use Git Bash / MSYS2, or run .\manifests.ps1 / .\generate.ps1 from PowerShell.
# controller-gen v0.15.0 does not build on Go 1.26; we pin v0.20.1 and invoke it via `go run` (no GOBIN install).

SHELL := bash

# Image
IMG ?= hive-operator:latest

# Get the currently used golang install path
GOROOT := $(shell go env GOROOT 2>/dev/null)
GOBIN := $(shell go env GOBIN 2>/dev/null)
ifeq ($(GOBIN),)
  GOBIN := $(shell go env GOPATH)/bin
endif

# Pin to a controller-tools release that compiles with Go 1.26 (older releases pull golang.org/x/tools that break the compiler).
CONTROLLER_GEN_VERSION ?= v0.20.1
CONTROLLER_GEN := go run sigs.k8s.io/controller-tools/cmd/controller-gen@$(CONTROLLER_GEN_VERSION)

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
	$(CONTROLLER_GEN) object:headerFile=hack/boilerplate.go.txt paths="./..."
	$(CONTROLLER_GEN) crd paths=./... webhook rbac:roleName=manager-role output:crd:artifacts:config=config/crd/bases

.PHONY: manifests
manifests:
	$(CONTROLLER_GEN) crd paths=./... webhook rbac:roleName=manager-role output:crd:artifacts:config=config/crd/bases

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
