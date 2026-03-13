# E2E tests: k3d cluster, deploy operator + mock control plane, run tests.
# Requires: k3d, Docker, kubectl. Run from Linux/WSL2.
# k3d is typically installed via: https://k3d.io or scripts/install-wsl2-toolchain.sh

SHELL := /bin/bash
K3D_CLUSTER ?= hive-e2e
OPERATOR_IMG ?= hive-operator:latest
WORKER_IMG ?= hive-worker:latest
MOCK_IMG ?= mock-controlplane:latest

# Registry-based e2e (optional): local registry so cluster pulls worker image from it.
REGISTRY_NAME ?= hive-e2e-registry
REGISTRY_PORT ?= 5000
REGISTRY_URL_INCLUSTER = $(REGISTRY_NAME):$(REGISTRY_PORT)
REGISTRY_URL_HOST = localhost:$(REGISTRY_PORT)
# When set (e.g. to $(REGISTRY_URL_INCLUSTER)/hive-worker:latest), deploy uses it for workerImage in the fixture.
E2E_WORKER_IMAGE ?=

.PHONY: test
test: clean cluster-create cluster-load deploy run-tests

.PHONY: cluster-create
cluster-create:
	k3d cluster create $(K3D_CLUSTER) --wait --timeout 2m

.PHONY: cluster-load
cluster-load:
	k3d image import $(OPERATOR_IMG) $(WORKER_IMG) $(MOCK_IMG) -c $(K3D_CLUSTER)

# --- Registry-based e2e (optional) ---

.PHONY: e2e-registry
e2e-registry:
	docker rm -f $(REGISTRY_NAME) 2>/dev/null || true
	docker run -d --name $(REGISTRY_NAME) -p $(REGISTRY_PORT):5000 --restart=always registry:2
	@sleep 2

# Generate k3s registries.yaml so the cluster can pull from our local registry (insecure HTTP).
testdata/registries.yaml: e2e-registry
	@mkdir -p testdata
	@echo 'mirrors:' > $@
	@echo '  "$(REGISTRY_NAME):5000":' >> $@
	@echo '    endpoint:' >> $@
	@echo '      - "http://$(REGISTRY_NAME):5000"' >> $@

.PHONY: cluster-create-with-registry
cluster-create-with-registry: testdata/registries.yaml
	k3d cluster create $(K3D_CLUSTER) --registry-config testdata/registries.yaml --wait --timeout 2m
	docker network connect k3d-$(K3D_CLUSTER) $(REGISTRY_NAME) 2>/dev/null || true

.PHONY: build-worker-registry
build-worker-registry:
	docker build -t $(REGISTRY_URL_HOST)/hive-worker:latest -f ../worker/Dockerfile ../worker
	docker push $(REGISTRY_URL_HOST)/hive-worker:latest

.PHONY: e2e-push-images
e2e-push-images: build-worker-registry

.PHONY: e2e-clean-registry
e2e-clean-registry:
	docker rm -f $(REGISTRY_NAME) 2>/dev/null || true

.PHONY: test-with-registry
test-with-registry: clean cluster-create-with-registry cluster-load e2e-push-images
	$(MAKE) deploy E2E_WORKER_IMAGE=$(REGISTRY_URL_INCLUSTER)/hive-worker:latest
	$(MAKE) run-tests

.PHONY: build-mock
build-mock:
	docker build -t $(MOCK_IMG) testdata/mock-controlplane

# Local-path provisioner: k3d has it by default; Kind needs it for juicefs-sc PVC binding.
LOCAL_PATH_PROVISIONER_URL ?= https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml
# Metrics API (kubectl top, HPA); silences metrics.k8s.io discovery errors in e2e.
METRICS_SERVER_URL ?= https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.6.4/components.yaml

.PHONY: deploy
deploy: crds
	kubectl apply -f ../manifests/crds/
	curl -sSL $(METRICS_SERVER_URL) | kubectl apply -f -
	-kubectl wait --for=condition=available --timeout=120s deployment/metrics-server -n kube-system
	-kubectl wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=120s
	kubectl create namespace hive-system --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f testdata/mock-controlplane-deployment.yaml
	kubectl apply -f ../manifests/operator/deployment.yaml
	curl -sSL $(LOCAL_PATH_PROVISIONER_URL) | kubectl apply -f -
	kubectl apply -f testdata/storage-class.yaml
	kubectl wait --for=condition=available --timeout=90s deployment/mock-controlplane -n default
	-kubectl wait --for=condition=available --timeout=90s deployment/local-path-provisioner -n local-path-storage
	@if [ -n "$(E2E_WORKER_IMAGE)" ]; then \
		kubectl apply -f testdata/fixtures/cluster.yaml && \
		kubectl apply -f testdata/fixtures/company.yaml && \
		sed 's|workerImage: .*|workerImage: $(E2E_WORKER_IMAGE)|' testdata/fixtures/workerpool.yaml | kubectl apply -f -; \
	else \
		kubectl apply -f testdata/fixtures/; \
	fi

.PHONY: crds
crds:
	$(MAKE) -C .. crds

.PHONY: run-tests
run-tests:
	E2E_KIND=1 go test -v -timeout 10m ./...

.PHONY: clean
clean:
	k3d cluster delete $(K3D_CLUSTER) 2>/dev/null || true
