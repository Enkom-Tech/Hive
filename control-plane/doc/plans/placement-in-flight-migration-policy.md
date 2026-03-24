# Placement: in-flight migration policy (v1)

**Rule:** Until a future policy explicitly allows checkpointed or cooperative handoff, the control plane does **not** silently move an already-dispatched run to another worker host or instance.

**Allowed automation today**

- **Cancel + requeue:** Stop the run (or mark failed with a documented code), release issue execution if applicable, and enqueue a new heartbeat run if the product workflow permits. This may lose in-memory adapter state; operators accept that trade-off for v1.

**Out of scope for v1**

- Transparent TCP/process migration, shared filesystem handoff without cancel, or “resume on new host” without a defined checkpoint contract between drone and control plane.

**Rollback**

- Roll back to a **prior release image** if dispatch semantics regress; do not maintain parallel agent-keyed vs instance-keyed registry implementations in one binary. See `doc/adr/003-unified-managed-worker-links.md` and `docs/deploy/security-runbook.md`.
