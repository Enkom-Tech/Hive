# Hive CRDs

CRDs for HiveCluster, HiveCompany, HiveWorkerPool (API group `hive.io/v1alpha1`).

**Source of truth:** `operator/config/crd/bases/` (relative to `infra/`). After changing the operator schema and regenerating (e.g. `make -C operator generate` from `infra/`), run from `infra/`:

```bash
make crds
```

(or from repo root: `make -C infra crds`) to copy the generated YAMLs here. E2E and deploy flows apply from this directory.

**Note:** `make generate` in the operator can fail on Go 1.26+ due to a dependency (golang.org/x/tools). If that happens, either run generate with Go 1.22 (e.g. `GO_VERSION=1.22 make generate`) or update the CRD YAMLs in `operator/config/crd/bases/` and `manifests/crds/` by hand to match the Go structs, then run `make crds`.
