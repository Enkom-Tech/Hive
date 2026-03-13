# Hive repo root Makefile. Delegates to infra/ for operator, worker, e2e.
# Run from repo root: make ci, make e2e, etc. Or: cd infra && make ci

.PHONY: check-env ci lint lint-manifests test test-unit test-integration build scan scan-images e2e-build crds e2e e2e-with-registry clean

check-env ci lint lint-manifests test test-unit test-integration build scan scan-images e2e-build crds e2e e2e-with-registry clean:
	$(MAKE) -C infra $@
