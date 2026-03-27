# Authorization matrix: managed worker pool mode

**Status:** Updated for ADR 003 (unified instance-keyed registry).  
**Definition of done:** Every pool-related HTTP route has a row; CI includes parametrized tests for wrong `companyId` / wrong resource scope → **403** (or documented **404** policy if you intentionally hide existence).

Related: [threat-model-managed-worker-pool.md](./threat-model-managed-worker-pool.md), existing pattern for agent link enrollment in [server/src/routes/agents/keys.ts](../../server/src/routes/agents/keys.ts).

## Conventions

- **Company scope:** Typically `assertCompanyAccess(req, companyId)` or equivalent session/board check used elsewhere on company-scoped routes.
- **Resource check:** Row’s `company_id` (or join) must match the path `companyId` and the principal’s access.
- **403 vs 404:** Prefer **403** when the principal is authenticated but not allowed; use **404** only if the product requires hiding resource existence (document in the row).

## Matrix

| Route | Method | Actor | Company scope | Resource check | Expected deny cases | Test file / id |
| ----- | ------ | ----- | ------------- | -------------- | ------------------- | -------------- |
| `POST /api/agents/:id/link-enrollment-tokens` | POST | Board (existing) | `assertCompanyAccess` for agent’s company | Agent exists, type managed_worker | Wrong company in session vs agent | Existing agents route tests |
| `GET /api/companies/:companyId/drones/overview` | GET | Board | `assertCompanyAccess(companyId)` | — | UUID swap in path | Existing overview tests |
| `POST /api/companies/:companyId/worker-instances/:workerInstanceId/link-enrollment-tokens` | POST | Board | `assertCompanyAccess(companyId)` | `worker_instances.company_id = companyId` (enforced in service) | Another company’s instance id in path | [`worker-instance-link-enrollment.test.ts`](../../server/src/__tests__/worker-instance-link-enrollment.test.ts) |
| `POST /api/companies/:companyId/drone-provisioning-tokens` | POST | Board | `assertCompanyAccess(companyId)` | — | Wrong company in path vs session | [`drone-provisioning-tokens.test.ts`](../../server/src/__tests__/drone-provisioning-tokens.test.ts) |
| `PUT /api/companies/:companyId/worker-instances/:workerInstanceId/agents/:agentId` | PUT | Board | `assertCompanyAccess(companyId)` | Agent + instance same company; `managed_worker` | Cross-company ids | Service-layer checks in `agentService` |
| `DELETE /api/companies/:companyId/worker-instances/agents/:agentId` | DELETE | Board | `assertCompanyAccess(companyId)` | Agent same company | Cross-company agent id | Service-layer checks |
| `POST /api/companies/:companyId/agents/:agentId/worker-pool/rotate` | POST | Board | `assertCompanyAccess(companyId)` | Agent same company; `managed_worker`; `worker_placement_mode=automatic` | Cross-company ids; non-board actor | [`worker-pool-mobility-authz.test.ts`](../../server/src/__tests__/worker-pool-mobility-authz.test.ts) |
| `PATCH /api/companies/:companyId/worker-instances/:workerInstanceId` | PATCH | Board | `assertCompanyAccess(companyId)` | `worker_instances.company_id = companyId` | Cross-company instance id; non-board actor | [`worker-pool-mobility-authz.test.ts`](../../server/src/__tests__/worker-pool-mobility-authz.test.ts) |
| Instance enrollment consume | — | Drone | — | WebSocket upgrade verifies token → instance row | Replay consumed token → reject | `server/src/workers/worker-link.ts` |
| Pool debug / admin read | — | — | — | `GET /api/companies/:companyId/worker-link-debug` (board; in-memory per API replica) | — | N/A (use company-scoped drones/overview + logs) |

## WebSocket `/api/workers/link`

Not an HTTP AuthZ matrix row in the same sense; authorization is **token hash** or **agent API key** at upgrade time. Document here:

- Instance-scoped token: must resolve to `(companyId, workerInstanceRowId)` and reject if instance terminated or company mismatch.
- Agent-scoped token: unchanged — resolves to `(companyId, agentId)` at upgrade; dispatch still uses unified instance-keyed registry after `hello` (ADR 003).
- **Provision token** (`hive_dpv_…`): resolves to `companyId` at upgrade; **not** consumed until first valid provision `hello` (ADR 004).

## Test checklist (for implementers)

- [x] Parametrized: `POST .../worker-instances/.../link-enrollment-tokens` with URL `companyId` not in principal’s access → **403** ([`worker-instance-link-enrollment.test.ts`](../../server/src/__tests__/worker-instance-link-enrollment.test.ts)).
- [x] Rate limits: instance mint path uses the same sensitive limiter as agent link-enrollment ([`app.ts`](../../server/src/app.ts)).
- [x] Agent token cannot subscribe to another company’s live events WebSocket: `authorizeCompanyEventsAccess` enforces `key.companyId ===` URL `companyId` ([`company-events-auth-cross-company.test.ts`](../../server/src/__tests__/company-events-auth-cross-company.test.ts)). `/api/workers/link` has no path `companyId`; company comes only from token resolution in [`worker-link.ts`](../../server/src/workers/worker-link.ts).
- [x] Pool mobility board APIs (`POST .../worker-pool/rotate`, `PATCH .../worker-instances/:id`) deny cross-company and non-board actors ([`worker-pool-mobility-authz.test.ts`](../../server/src/__tests__/worker-pool-mobility-authz.test.ts)).

## References

- [threat-model-managed-worker-pool.md](./threat-model-managed-worker-pool.md)
- [security-runbook.md](../../docs/deploy/security-runbook.md)
