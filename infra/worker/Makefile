SHELL := /bin/bash
UNAME_S := $(shell uname -s 2>/dev/null)
ifeq ($(UNAME_S),Linux)
else ifeq ($(UNAME_S),Darwin)
else
  $(error "Worker build requires Linux or macOS (use WSL2 on Windows)")
endif

GOBIN := $(shell go env GOBIN 2>/dev/null)
ifeq ($(GOBIN),)
  GOBIN := $(shell go env GOPATH)/bin
endif

.PHONY: build
build:
	go build -o hive-worker ./cmd/worker

.PHONY: test-unit
test-unit:
	go test ./... -short -race -count=1

.PHONY: lint
lint:
	$(GOBIN)/golangci-lint run ./...

.PHONY: docker-build
docker-build:
	docker build -t hive-worker:latest .

.PHONY: gosec
gosec:
	$(GOBIN)/gosec ./...

.PHONY: govulncheck
govulncheck:
	$(GOBIN)/govulncheck ./...

.PHONY: clean
clean:
	rm -f hive-worker coverage.out
