# Threat model addendum: `request_deploy`

**Status:** Living artifact — companion to [threat-model-managed-worker-pool.md](./threat-model-managed-worker-pool.md) and [DRONE-SPEC.md](../DRONE-SPEC.md) §7.

## Scope

`request_deploy` lets a board-authorized flow grant a **specific** image reference (digest-pinned) for a worker to pull and optionally run verification hooks. It is **not** arbitrary registry access from the worker.

## Trust boundaries

- **Board / operator** defines company policy (allowlisted registries, digest requirement, cosign requirement).
- **Control plane** mints **short-lived deploy grants** tied to `companyId`, `worker_instance_id` or pool, and exact image digest.
- **Worker** verifies grant, policy, and optional **cosign** signatures before `docker pull` / equivalent.

## STRIDE-oriented threats

| ID | Category | Scenario | Mitigation |
|----|----------|----------|------------|
| RD-01 | Spoofing | Stolen worker JWT used to request deploy for another company | Grants are created server-side; worker only accepts WS `deploy_grant` or API responses scoped to its JWT `company_id` |
| RD-02 | Tampering | Worker pulls a different digest than granted | Grant embeds immutable digest; worker rejects mismatch |
| RD-03 | Elevation | Attacker pushes malicious image to allowlisted registry | Digest pinning + cosign policy; board-only grant creation |
| RD-04 | DoS | Flood of pull requests exhausts disk or registry | Per-company quotas, concurrency caps, audit metrics |
| RD-05 | Repudiation | Deploy happened without audit trail | Activity log + structured metrics (`hive_deploy_*`) |
| RD-06 | Elevation | Grant references digest on allowlisted registry but operator intends stricter **runtime** image policy | After signature/registry checks, worker applies the same `HIVE_CONTAINER_IMAGE_ALLOWLIST` / `HIVE_CONTAINER_IMAGE_ENFORCE` rules as `docker run` (`executor.EnforceContainerImagePolicy`) before `docker pull`; deny logs as `deploy_grant: container image policy` |

## Residual risk

Compromised worker host can still abuse **local** docker if credentials exist; v1 assumes worker runtime is operator-hardened. Cluster credentials are out of scope for v1.
