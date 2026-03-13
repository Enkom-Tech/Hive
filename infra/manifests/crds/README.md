# Hive CRDs

CRDs for HiveCluster, HiveCompany, HiveWorkerPool (API group `hive.io/v1alpha1`).

**Source of truth:** `operator/config/crd/bases/` (relative to `infra/`). After changing the operator schema and regenerating (e.g. `make -C operator generate` from `infra/`), run from `infra/`:

```bash
make crds
```

(or from repo root: `make -C infra crds`) to copy the generated YAMLs here. E2E and deploy flows apply from this directory.
