# Hive repo root Makefile. Delegates to infra/ for operator, worker, e2e; to control-plane/ for API+UI.
# Run from repo root: make ci, make e2e, make control-plane-dev, etc.

.PHONY: check-env ci lint lint-manifests test test-unit test-integration build scan scan-images e2e-build crds e2e e2e-with-registry clean
.PHONY: control-plane-dev control-plane-test control-plane-typecheck control-plane-install

check-env ci lint lint-manifests test test-unit test-integration build scan scan-images e2e-build crds e2e e2e-with-registry clean:
	$(MAKE) -C infra $@

control-plane-install:
	cd control-plane && pnpm install

control-plane-typecheck:
	cd control-plane && pnpm typecheck

control-plane-test:
	cd control-plane && pnpm test:run

control-plane-dev:
	cd control-plane && pnpm dev
