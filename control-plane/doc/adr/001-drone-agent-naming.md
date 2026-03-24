# ADR 001: Drone / agent API and schema naming

## Status

Accepted — implemented as breaking change (no backward compatibility).

## Context

The product distinguishes **agents/employees** (board `managed_worker` rows and their runtime) from **drones** (`hive-worker` + `worker_instances`). REST paths and JSON used “workers” ambiguously; the enrollment table name did not match the security model (tokens authorize **as** a board agent).

## Decision

- **GET** ` /api/companies/:companyId/drones/overview` — replaces `workers/overview`.
- **POST** `/api/agents/:id/link-enrollment-tokens` — replaces `worker-enrollment-tokens`.
- **JSON:** `boardAgents`, `unassignedBoardAgents`, `instances[].boardAgents`; remove `agents` / `unassignedAgents` at root and nested `agents`.
- **PG table:** `managed_worker_link_enrollment_tokens` (renamed from `worker_enrollment_tokens`).
- **Service:** `listDroneBoardAgentOverview` replaces `listWorkerDeploymentOverview`.
- **Browser route:** `/workers` retained for bookmarks; sidebar label clarifies drones + links.

## Rejected

- Temporary dual routes or deprecated aliases — operators upgrade control plane + UI in one window.

## Consumer manifest (grep)

Areas that must stay aligned after the cutover (see also `pnpm check:legacy-drone-api` in CI):

| Area | Files / packages |
|------|------------------|
| HTTP routes | `server/src/routes/agents/list-get.ts`, `keys.ts`, `app.ts` (sensitive path regex) |
| Services | `server/src/services/agents.ts` (`listDroneBoardAgentOverview`, `createLinkEnrollmentToken`) |
| WebSocket / enrollment | `server/src/workers/worker-link.ts` |
| DB | `packages/db/src/schema/managed_worker_link_enrollment_tokens.ts`, `worker_instances.ts`, migration `0035_drone_agent_alignment.sql` |
| UI | `ui/src/api/workers.ts`, `agents.ts`, `lib/queryKeys.ts`, `pages/Workers.tsx`, onboarding / enroll components |
| CLI | No HTTP path to overview; `worker-link.ts` uses env names only |
| Tests | `server/src/__tests__/agents-routes-split.test.ts` and route mocks |
| Docs | `docs/api/workers.md`, `docs/api/agents.md`, `docs/deploy/security-runbook.md`, `doc/MANAGED-WORKER-ARCHITECTURE.md`, `CHANGELOG.md` |
| Placement v1 | `server/src/services/placement.ts`, `placement-metrics.ts`, `adapters/managed-worker/execute-deps.ts`, migration `0036_run_placements`, `doc/adr/002-placement-registry-option-a.md` |

## References

- [worker-pool-and-placement.md](../plans/worker-pool-and-placement.md)
- [002-placement-registry-option-a.md](./002-placement-registry-option-a.md) — run placement (Release B)
