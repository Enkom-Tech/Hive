# Infra program conventions (feature flags, observability, docs)

This document supports the multi-phase infra hardening program (worker policy, VCS webhooks, workspace materialization, placement drain, release gates).

## Feature flags

- **Naming:** `HIVE_<AREA>_<BEHAVIOR>[_ENABLED]` for boolean gates (examples: `HIVE_REQUEST_DEPLOY_ENABLED`, `HIVE_PLACEMENT_V1_ENABLED`).
- **Defaults:** Safer for dev/local; stricter posture requires explicit operator opt-in for production-breaking changes (e.g. staged autosandbox).
- **Documentation:** New flags must appear in [environment-variables.md](environment-variables.md) when behavior is user-visible.

## Observability

- **Control plane:** Structured logs with stable keys (`companyId`, `runId`, `placementId`, `workerInstanceId`); avoid logging secrets and raw webhook bodies.
- **Worker:** Prefixes already used (`link:`, `deploygrant:`, `hive-mcp:`); new subsystems should use a consistent single-line prefix for grep-friendly ops.
- **Metrics:** When adding denial paths (policy, webhook reject), prefer counters with low-cardinality labels.

## Documentation update process

When a phase lands:

1. Update [SPEC-implementation.md](../../doc/SPEC-implementation.md) if the implementation contract changes.
2. Update [DRONE-SPEC.md](../../doc/DRONE-SPEC.md) §10 gap table when worker behavior changes.
3. Update [issue-worktree-support.md](../../doc/experimental/issue-worktree-support.md) for workspace topology notes.
4. Link threat models from [security-runbook.md](security-runbook.md) *Related* sections as features go live.

## Related threat models

- [threat-model-request-deploy.md](../../doc/plans/threat-model-request-deploy.md)
- [threat-model-vcs-webhooks.md](../../doc/plans/threat-model-vcs-webhooks.md)
- [threat-model-worker-workspace-materialization.md](../../doc/plans/threat-model-worker-workspace-materialization.md)

## Release verification

- [RELEASE-CHECKLIST-infra-flags.md](RELEASE-CHECKLIST-infra-flags.md)
